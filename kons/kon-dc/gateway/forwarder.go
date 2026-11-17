package main

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"
)

// Forwarder batches gateway events and POSTs them to the kon. Shards never block on the API: they
// push into a bounded buffer, and when the API is down long enough to fill it the OLDEST events
// are dropped and counted. Losing a stale "someone sent a message" is better than stalling the
// gateway, missing heartbeats and losing the session.
type Forwarder struct {
	kon      *KonClient
	log      *slog.Logger
	max      int
	interval time.Duration

	mu     sync.Mutex
	buf    []GatewayEventEnvelope
	cap    int
	wake   chan struct{}
	filter atomic.Pointer[map[string]bool]

	Forwarded atomic.Int64
	Dropped   atomic.Int64 // dropped here (buffer full) or by the kon (its queue full)
	Filtered  atomic.Int64 // types no module asked for
	LastOK    atomic.Int64 // unix seconds of the last accepted batch
}

func NewForwarder(kon *KonClient, log *slog.Logger, max, capacity int, interval time.Duration) *Forwarder {
	f := &Forwarder{kon: kon, log: log, max: max, interval: interval, cap: capacity, wake: make(chan struct{}, 1)}
	empty := map[string]bool{}
	f.filter.Store(&empty)
	return f
}

// SetEvents replaces the set of dispatch types worth forwarding (from the kon's config).
func (f *Forwarder) SetEvents(events []string) {
	m := make(map[string]bool, len(events))
	for _, e := range events {
		m[e] = true
	}
	f.filter.Store(&m)
}

// Push is called from shard read loops. It never blocks.
func (f *Forwarder) Push(e GatewayEventEnvelope) {
	if !(*f.filter.Load())[e.T] {
		f.Filtered.Add(1)
		return
	}
	f.mu.Lock()
	if len(f.buf) >= f.cap {
		f.buf = f.buf[1:]
		f.Dropped.Add(1)
	}
	f.buf = append(f.buf, e)
	full := len(f.buf) >= f.max
	f.mu.Unlock()
	if full {
		select {
		case f.wake <- struct{}{}:
		default:
		}
	}
}

func (f *Forwarder) take() []GatewayEventEnvelope {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := min(len(f.buf), f.max)
	if n == 0 {
		return nil
	}
	batch := make([]GatewayEventEnvelope, n)
	copy(batch, f.buf[:n])
	f.buf = f.buf[n:]
	return batch
}

// giveBack returns a failed batch to the front of the buffer, within capacity.
func (f *Forwarder) giveBack(batch []GatewayEventEnvelope) {
	f.mu.Lock()
	defer f.mu.Unlock()
	room := f.cap - len(f.buf)
	if room <= 0 {
		f.Dropped.Add(int64(len(batch)))
		return
	}
	if len(batch) > room {
		f.Dropped.Add(int64(len(batch) - room))
		batch = batch[len(batch)-room:]
	}
	f.buf = append(append(make([]GatewayEventEnvelope, 0, len(batch)+len(f.buf)), batch...), f.buf...)
}

// Run sends batches until ctx ends, backing off while the API fails.
func (f *Forwarder) Run(ctx context.Context) {
	ticker := time.NewTicker(f.interval)
	defer ticker.Stop()
	backoff := time.Duration(0)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		case <-f.wake:
		}
		if backoff > 0 {
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
		}
		for {
			batch := f.take()
			if batch == nil {
				break
			}
			sendCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
			res, err := f.kon.Send(sendCtx, batch)
			cancel()
			if err != nil {
				if errors.Is(err, errPermanent) {
					// A 4xx will not get better by retrying the same batch: drop it and say why.
					f.Dropped.Add(int64(len(batch)))
					f.log.Error("kon refused a batch; dropped", "events", len(batch), "err", err)
					break
				}
				f.giveBack(batch)
				backoff = min(max(backoff*2, 500*time.Millisecond), 30*time.Second)
				f.log.Warn("kon unreachable; will retry", "events", len(batch), "retryIn", backoff.String(), "err", err)
				break
			}
			backoff = 0
			f.Forwarded.Add(int64(res.Accepted))
			f.Dropped.Add(int64(res.Dropped))
			f.LastOK.Store(time.Now().Unix())
			if res.Dropped > 0 {
				f.log.Warn("kon queue full; it dropped events", "dropped", res.Dropped)
			}
		}
	}
}
