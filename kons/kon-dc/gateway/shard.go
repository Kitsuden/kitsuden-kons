package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"sync"
	"sync/atomic"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

// Gateway opcodes (https://discord.com/developers/docs/topics/opcodes-and-status-codes).
const (
	opDispatch       = 0
	opHeartbeat      = 1
	opIdentify       = 2
	opResume         = 6
	opReconnect      = 7
	opInvalidSession = 9
	opHello          = 10
	opHeartbeatAck   = 11
)

type inbound struct {
	Op int             `json:"op"`
	D  json.RawMessage `json:"d"`
	S  *int64          `json:"s"`
	T  string          `json:"t"`
}

type outbound struct {
	Op int `json:"op"`
	D  any `json:"d"`
}

// Close codes after which reconnecting with the same settings cannot work.
var fatalCloses = map[websocket.StatusCode]string{
	4004: "authentication failed: check DISCORD_BOT_TOKEN",
	4010: "invalid shard",
	4011: "sharding required: set DISCORD_SHARD_COUNT or leave it 0",
	4012: "invalid API version",
}

// Close codes that only a different config fixes (a module switched off, or the intent enabled in
// the Developer Portal). The shard waits for the next config revision instead of hammering Discord.
var configCloses = map[websocket.StatusCode]string{
	4013: "invalid intents",
	4014: "disallowed intents: enable Server Members / Message Content in the Developer Portal (Bot page), or switch off the modules that need them",
}

// Close codes after which the session cannot be resumed.
var freshSessionCloses = map[websocket.StatusCode]bool{4007: true, 4009: true}

type fatalError struct{ reason string }

func (e *fatalError) Error() string { return e.reason }

type blockedError struct{ reason string }

func (e *blockedError) Error() string { return e.reason }

var errReconnect = errors.New("reconnect requested")

// IdentifyGate enforces Discord's identify rate: one IDENTIFY per 5 s per bucket, where bucket =
// shard id % max_concurrency.
type IdentifyGate struct {
	mu      sync.Mutex
	buckets map[int]*sync.Mutex
	last    map[int]time.Time
	concur  int
}

func NewIdentifyGate(maxConcurrency int) *IdentifyGate {
	return &IdentifyGate{buckets: map[int]*sync.Mutex{}, last: map[int]time.Time{}, concur: max(1, maxConcurrency)}
}

func (g *IdentifyGate) Wait(ctx context.Context, shard int) error {
	key := shard % g.concur
	g.mu.Lock()
	lock, ok := g.buckets[key]
	if !ok {
		lock = &sync.Mutex{}
		g.buckets[key] = lock
	}
	g.mu.Unlock()
	lock.Lock()
	defer lock.Unlock()
	g.mu.Lock()
	wait := time.Until(g.last[key].Add(5 * time.Second))
	g.mu.Unlock()
	if wait > 0 {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(wait):
		}
	}
	g.mu.Lock()
	g.last[key] = time.Now()
	g.mu.Unlock()
	return nil
}

// Shard is one gateway connection. It resumes when it can and identifies again when it must.
type Shard struct {
	ID, Count  int
	token      string
	gatewayURL string
	log        *slog.Logger
	fwd        *Forwarder
	gate       *IdentifyGate

	intents    atomic.Int64
	reidentify chan struct{}

	// The session is written by the read loop (READY) and cleared by the re-identify goroutine.
	sessMu    sync.Mutex
	sessionID string
	resumeURL string
	seq       atomic.Int64 // -1 = none yet

	Ready      atomic.Bool
	Reconnects atomic.Int64
	Problem    atomic.Pointer[string] // fatal or blocked reason, shown in /healthz
	Fatal      atomic.Bool
}

func NewShard(id, count int, token, gatewayURL string, intents int, fwd *Forwarder, gate *IdentifyGate, log *slog.Logger) *Shard {
	s := &Shard{
		ID: id, Count: count, token: token, gatewayURL: gatewayURL, fwd: fwd, gate: gate,
		log: log.With("shard", id), reidentify: make(chan struct{}, 1),
	}
	s.intents.Store(int64(intents))
	s.seq.Store(-1)
	return s
}

// SetIntents changes the intents and, if they differ, asks the shard to identify again (intents
// are fixed per session).
func (s *Shard) SetIntents(intents int) {
	if s.intents.Swap(int64(intents)) == int64(intents) && s.Problem.Load() == nil {
		return
	}
	select {
	case s.reidentify <- struct{}{}:
	default:
	}
}

func (s *Shard) resetSession() {
	s.sessMu.Lock()
	s.sessionID = ""
	s.resumeURL = ""
	s.sessMu.Unlock()
	s.seq.Store(-1)
}

func (s *Shard) setSession(id, resumeURL string) {
	s.sessMu.Lock()
	s.sessionID, s.resumeURL = id, resumeURL
	s.sessMu.Unlock()
}

// session returns the session to resume, if any.
func (s *Shard) session() (id, resumeURL string) {
	s.sessMu.Lock()
	defer s.sessMu.Unlock()
	return s.sessionID, s.resumeURL
}

// Run keeps the shard connected until ctx ends or a fatal close.
func (s *Shard) Run(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		start := time.Now()
		err := s.connect(ctx)
		s.Ready.Store(false)
		if ctx.Err() != nil {
			return
		}
		var fe *fatalError
		if errors.As(err, &fe) {
			msg := fe.reason
			s.Problem.Store(&msg)
			s.Fatal.Store(true)
			s.log.Error("gateway closed for good", "reason", fe.reason)
			return
		}
		var be *blockedError
		if errors.As(err, &be) {
			msg := be.reason
			s.Problem.Store(&msg)
			s.log.Error("gateway refused the intents; waiting for a config change", "reason", be.reason)
			s.resetSession()
			select {
			case <-ctx.Done():
				return
			case <-s.reidentify:
				s.Problem.Store(nil)
				continue
			}
		}
		s.Reconnects.Add(1)
		if time.Since(start) > time.Minute {
			backoff = time.Second
		}
		jitter := time.Duration(rand.Int64N(int64(backoff)/2 + 1))
		sid, _ := s.session()
		s.log.Warn("gateway connection ended; reconnecting", "err", err, "in", (backoff + jitter).String(), "resume", sid != "")
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff + jitter):
		}
		backoff = min(backoff*2, time.Minute)
	}
}

func (s *Shard) connect(ctx context.Context) error {
	sessionID, resumeURL := s.session()
	resuming := sessionID != "" && s.seq.Load() >= 0
	base := s.gatewayURL
	if resuming && resumeURL != "" {
		base = resumeURL
	}
	conn, _, err := websocket.Dial(ctx, base+"/?v=10&encoding=json", nil)
	if err != nil {
		return fmt.Errorf("dial: %w", err)
	}
	defer conn.CloseNow()
	// A GUILD_CREATE of a big server is large; the worker trims it before forwarding.
	conn.SetReadLimit(32 << 20)

	connCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	// HELLO
	var hello inbound
	if err := wsjson.Read(connCtx, conn, &hello); err != nil {
		return fmt.Errorf("hello: %w", err)
	}
	if hello.Op != opHello {
		return fmt.Errorf("expected HELLO, got op %d", hello.Op)
	}
	var h struct {
		HeartbeatInterval int64 `json:"heartbeat_interval"`
	}
	if err := json.Unmarshal(hello.D, &h); err != nil || h.HeartbeatInterval <= 0 {
		return fmt.Errorf("bad HELLO payload")
	}
	interval := time.Duration(h.HeartbeatInterval) * time.Millisecond

	var acked atomic.Bool
	acked.Store(true)
	sendHeartbeat := func() error {
		var d any
		if seq := s.seq.Load(); seq >= 0 {
			d = seq
		}
		return wsjson.Write(connCtx, conn, outbound{Op: opHeartbeat, D: d})
	}

	// Heartbeats. A missed ACK means a zombie connection: drop it (without a close frame, so the
	// session stays resumable) and resume.
	go func() {
		timer := time.NewTimer(time.Duration(rand.Float64() * float64(interval)))
		defer timer.Stop()
		for {
			select {
			case <-connCtx.Done():
				return
			case <-timer.C:
			}
			if !acked.Load() {
				s.log.Warn("heartbeat not acknowledged; dropping zombie connection")
				conn.CloseNow()
				return
			}
			acked.Store(false)
			if err := sendHeartbeat(); err != nil {
				return
			}
			timer.Reset(interval)
		}
	}()

	// Re-identify on request (new intents): a normal close ends the session on purpose.
	go func() {
		select {
		case <-connCtx.Done():
		case <-s.reidentify:
			s.log.Info("intents changed; identifying again")
			s.resetSession()
			_ = conn.Close(websocket.StatusNormalClosure, "re-identify")
		}
	}()

	if resuming {
		err = wsjson.Write(connCtx, conn, outbound{Op: opResume, D: map[string]any{
			"token": s.token, "session_id": sessionID, "seq": s.seq.Load(),
		}})
	} else {
		if err := s.gate.Wait(connCtx, s.ID); err != nil {
			return err
		}
		err = wsjson.Write(connCtx, conn, outbound{Op: opIdentify, D: map[string]any{
			"token":   s.token,
			"intents": s.intents.Load(),
			"shard":   []int{s.ID, s.Count},
			"properties": map[string]string{
				"os": "linux", "browser": "kitsuden", "device": "kitsuden",
			},
		}})
	}
	if err != nil {
		return fmt.Errorf("identify/resume: %w", err)
	}

	for {
		_, data, err := conn.Read(connCtx)
		if err != nil {
			code := websocket.CloseStatus(err)
			if reason, ok := fatalCloses[code]; ok {
				return &fatalError{reason: fmt.Sprintf("%d %s", code, reason)}
			}
			if reason, ok := configCloses[code]; ok {
				return &blockedError{reason: fmt.Sprintf("%d %s", code, reason)}
			}
			if freshSessionCloses[code] {
				s.resetSession()
			}
			return err
		}
		var p inbound
		if err := json.Unmarshal(data, &p); err != nil {
			s.log.Warn("unreadable gateway frame", "err", err)
			continue
		}
		if p.S != nil {
			s.seq.Store(*p.S)
		}
		switch p.Op {
		case opDispatch:
			s.dispatch(p)
		case opHeartbeat:
			if err := sendHeartbeat(); err != nil {
				return err
			}
		case opHeartbeatAck:
			acked.Store(true)
		case opReconnect:
			return errReconnect
		case opInvalidSession:
			var resumable bool
			_ = json.Unmarshal(p.D, &resumable)
			if !resumable {
				s.resetSession()
			}
			// Discord asks for a random 1–5 s wait before the next IDENTIFY.
			time.Sleep(time.Second + time.Duration(rand.Int64N(int64(4*time.Second))))
			return errors.New("invalid session")
		}
	}
}

func (s *Shard) dispatch(p inbound) {
	switch p.T {
	case "READY":
		var r struct {
			SessionID        string `json:"session_id"`
			ResumeGatewayURL string `json:"resume_gateway_url"`
			User             struct {
				Username string `json:"username"`
			} `json:"user"`
			Guilds []json.RawMessage `json:"guilds"`
		}
		if err := json.Unmarshal(p.D, &r); err == nil {
			s.setSession(r.SessionID, r.ResumeGatewayURL)
			s.Ready.Store(true)
			s.Problem.Store(nil)
			s.log.Info("ready", "bot", r.User.Username, "guilds", len(r.Guilds), "intents", s.intents.Load())
		}
		return
	case "RESUMED":
		s.Ready.Store(true)
		s.log.Info("resumed")
		return
	}
	if p.S == nil {
		return
	}
	d := p.D
	if p.T == "GUILD_CREATE" || p.T == "GUILD_UPDATE" {
		// Only what the kon stores: the full payload (members, channels…) can be megabytes.
		var g struct {
			ID          string `json:"id"`
			Name        string `json:"name"`
			Unavailable bool   `json:"unavailable"`
		}
		if json.Unmarshal(p.D, &g) != nil {
			return
		}
		d, _ = json.Marshal(g)
	}
	s.fwd.Push(GatewayEventEnvelope{
		T:          p.T,
		S:          *p.S,
		Shard:      [2]int{s.ID, s.Count},
		ReceivedAt: time.Now().UTC().Format(time.RFC3339Nano),
		D:          d,
	})
}
