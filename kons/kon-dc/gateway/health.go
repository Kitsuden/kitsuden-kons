package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"runtime"
	"time"
)

type shardHealth struct {
	ID         int    `json:"id"`
	Ready      bool   `json:"ready"`
	Reconnects int64  `json:"reconnects"`
	Problem    string `json:"problem,omitempty"`
}

// serveHealth exposes /healthz (JSON, 200 when every shard is connected) and /metrics
// (Prometheus text). It listens inside the container network only; it holds no secrets.
func serveHealth(ctx context.Context, addr string, shards []*Shard, fwd *Forwarder, log *slog.Logger) {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		ok := true
		list := make([]shardHealth, 0, len(shards))
		for _, s := range shards {
			h := shardHealth{ID: s.ID, Ready: s.Ready.Load(), Reconnects: s.Reconnects.Load()}
			if p := s.Problem.Load(); p != nil {
				h.Problem = *p
			}
			ok = ok && h.Ready
			list = append(list, h)
		}
		w.Header().Set("Content-Type", "application/json")
		if !ok {
			w.WriteHeader(http.StatusServiceUnavailable)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ok": ok, "shards": list, "forwarded": fwd.Forwarded.Load(), "dropped": fwd.Dropped.Load(),
		})
	})
	mux.HandleFunc("GET /metrics", func(w http.ResponseWriter, _ *http.Request) {
		var mem runtime.MemStats
		runtime.ReadMemStats(&mem)
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		fmt.Fprintf(w, "dc_gateway_events_forwarded_total %d\n", fwd.Forwarded.Load())
		fmt.Fprintf(w, "dc_gateway_events_dropped_total %d\n", fwd.Dropped.Load())
		fmt.Fprintf(w, "dc_gateway_events_filtered_total %d\n", fwd.Filtered.Load())
		fmt.Fprintf(w, "dc_gateway_last_batch_ok_seconds %d\n", fwd.LastOK.Load())
		for _, s := range shards {
			ready := 0
			if s.Ready.Load() {
				ready = 1
			}
			fmt.Fprintf(w, "dc_gateway_shard_ready{shard=\"%d\"} %d\n", s.ID, ready)
			fmt.Fprintf(w, "dc_gateway_shard_reconnects_total{shard=\"%d\"} %d\n", s.ID, s.Reconnects.Load())
		}
		fmt.Fprintf(w, "dc_gateway_heap_bytes %d\n", mem.HeapAlloc)
		fmt.Fprintf(w, "dc_gateway_gc_pause_total_seconds %f\n", float64(mem.PauseTotalNs)/1e9)
		fmt.Fprintf(w, "dc_gateway_goroutines %d\n", runtime.NumGoroutine())
	})

	srv := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}
	go func() {
		<-ctx.Done()
		shutdown, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdown)
	}()
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Error("health server stopped", "err", err)
	}
}
