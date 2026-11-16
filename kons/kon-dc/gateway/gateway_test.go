package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

// fakeKon records the batches the worker posts and serves a fixed config.
type fakeKon struct {
	mu      sync.Mutex
	batches []GatewayEventBatch
	auth    []string
	config  GatewayConfig
}

func (k *fakeKon) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/dc/gateway/config", func(w http.ResponseWriter, r *http.Request) {
		k.mu.Lock()
		k.auth = append(k.auth, r.Header.Get("Authorization"))
		cfg := k.config
		k.mu.Unlock()
		_ = json.NewEncoder(w).Encode(cfg)
	})
	mux.HandleFunc("POST /api/dc/gateway/events", func(w http.ResponseWriter, r *http.Request) {
		var b GatewayEventBatch
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &b); err != nil {
			http.Error(w, "bad", http.StatusUnprocessableEntity)
			return
		}
		k.mu.Lock()
		k.batches = append(k.batches, b)
		k.auth = append(k.auth, r.Header.Get("Authorization"))
		k.mu.Unlock()
		w.WriteHeader(http.StatusAccepted)
		_ = json.NewEncoder(w).Encode(GatewayIngestResult{Accepted: len(b.Events)})
	})
	return mux
}

func (k *fakeKon) events() []GatewayEventEnvelope {
	k.mu.Lock()
	defer k.mu.Unlock()
	var out []GatewayEventEnvelope
	for _, b := range k.batches {
		out = append(out, b.Events...)
	}
	return out
}

// fakeGateway speaks just enough of Discord's gateway: HELLO, expects IDENTIFY, READY, then the
// given dispatches, and acknowledges heartbeats.
func fakeGateway(t *testing.T, identify chan<- map[string]any, dispatches []map[string]any) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.URL.RawQuery, "v=10") {
			t.Errorf("gateway URL without v=10: %s", r.URL)
		}
		c, err := websocket.Accept(w, r, nil)
		if err != nil {
			return
		}
		defer c.CloseNow()
		ctx := r.Context()
		_ = wsjson.Write(ctx, c, map[string]any{"op": 10, "d": map[string]any{"heartbeat_interval": 200}})
		for {
			var msg struct {
				Op int             `json:"op"`
				D  json.RawMessage `json:"d"`
			}
			if err := wsjson.Read(ctx, c, &msg); err != nil {
				return
			}
			switch msg.Op {
			case 1:
				_ = wsjson.Write(ctx, c, map[string]any{"op": 11})
			case 2:
				var d map[string]any
				_ = json.Unmarshal(msg.D, &d)
				identify <- d
				_ = wsjson.Write(ctx, c, map[string]any{"op": 0, "s": 1, "t": "READY", "d": map[string]any{
					"session_id": "sess", "resume_gateway_url": "ws://unused", "user": map[string]any{"username": "bot"}, "guilds": []any{},
				}})
				for i, d := range dispatches {
					_ = wsjson.Write(ctx, c, map[string]any{"op": 0, "s": i + 2, "t": d["t"], "d": d["d"]})
				}
			}
		}
	}))
}

func TestShardForwardsOnlyRequestedEventsWithConfiguredIntents(t *testing.T) {
	kon := &fakeKon{config: GatewayConfig{
		Contract: ContractVersion, Intents: 1 | 512, Events: []string{"GUILD_CREATE", "MESSAGE_CREATE"}, Revision: "513",
	}}
	konSrv := httptest.NewServer(kon.handler())
	defer konSrv.Close()

	identify := make(chan map[string]any, 1)
	big := strings.Repeat("x", 50_000)
	gw := fakeGateway(t, identify, []map[string]any{
		{"t": "GUILD_CREATE", "d": map[string]any{"id": "123456789012345678", "name": "Test", "members": []any{big}}},
		{"t": "MESSAGE_CREATE", "d": map[string]any{"guild_id": "123456789012345678", "content": "hi", "author": map[string]any{"id": "1"}}},
		{"t": "TYPING_START", "d": map[string]any{"guild_id": "123456789012345678"}},
	})
	defer gw.Close()

	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	client := NewKonClient(konSrv.URL, "kitsuden_agent_test")
	cfg, err := client.Config(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	fwd := NewForwarder(client, log, 50, 100, 20*time.Millisecond)
	fwd.SetEvents(cfg.Events)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	go fwd.Run(ctx)
	shard := NewShard(0, 1, "token", "ws"+strings.TrimPrefix(gw.URL, "http"), cfg.Intents, fwd, NewIdentifyGate(1), log)
	go shard.Run(ctx)

	select {
	case d := <-identify:
		if int(d["intents"].(float64)) != cfg.Intents {
			t.Fatalf("identified with intents %v, want %d", d["intents"], cfg.Intents)
		}
		if d["token"] != "token" {
			t.Fatalf("identified without the bot token")
		}
	case <-ctx.Done():
		t.Fatal("no IDENTIFY")
	}

	deadline := time.Now().Add(5 * time.Second)
	for len(kon.events()) < 2 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}
	got := kon.events()
	if len(got) != 2 {
		t.Fatalf("forwarded %d events, want 2 (TYPING_START is filtered): %+v", len(got), got)
	}
	if got[0].T != "GUILD_CREATE" || got[1].T != "MESSAGE_CREATE" {
		t.Fatalf("unexpected order/types: %s, %s", got[0].T, got[1].T)
	}
	if len(got[0].D) > 200 || strings.Contains(string(got[0].D), "members") {
		t.Fatalf("GUILD_CREATE was not trimmed: %d bytes", len(got[0].D))
	}
	if got[1].Shard != [2]int{0, 1} || got[1].S != 3 {
		t.Fatalf("bad envelope: %+v", got[1])
	}
	if !shard.Ready.Load() {
		t.Fatal("shard not ready after READY")
	}
	for _, a := range kon.auth {
		if a != "Bearer kitsuden_agent_test" {
			t.Fatalf("request without the agent key: %q", a)
		}
	}
	if fwd.Filtered.Load() != 1 {
		t.Fatalf("filtered = %d, want 1", fwd.Filtered.Load())
	}
}

func TestForwarderDropsOldestWhenFull(t *testing.T) {
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	fwd := NewForwarder(NewKonClient("http://127.0.0.1:1", "x"), log, 50, 3, time.Second)
	fwd.SetEvents([]string{"MESSAGE_CREATE"})
	for i := range 5 {
		fwd.Push(GatewayEventEnvelope{T: "MESSAGE_CREATE", S: int64(i)})
	}
	batch := fwd.take()
	if len(batch) != 3 || batch[0].S != 2 {
		t.Fatalf("kept %+v, want the newest 3", batch)
	}
	if fwd.Dropped.Load() != 2 {
		t.Fatalf("dropped = %d, want 2", fwd.Dropped.Load())
	}
}

func TestPermanentKonErrorsAreNotRetried(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, `{"error":"Forbidden"}`, http.StatusForbidden)
	}))
	defer srv.Close()
	_, err := NewKonClient(srv.URL, "x").Config(context.Background())
	if err == nil || !strings.Contains(err.Error(), "permanent") {
		t.Fatalf("want a permanent error, got %v", err)
	}
}
