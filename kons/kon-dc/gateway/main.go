// Command dc-gateway holds the Discord gateway WebSocket for kon-dc.
//
// It does one job: keep the shards connected (heartbeats, resume, re-identify) and forward the
// dispatches the kon asked for, in batches, to POST /api/dc/gateway/events. It has no
// database, no bot logic and no state worth keeping: restart it freely. The API, in turn, can be
// redeployed without dropping the bot's gateway session.
//
// Why Go: a static ~6 MB binary on `scratch`, ~10 MB of memory per process for many shards, and
// goroutines for each shard's heartbeat and read loop. Garbage collection is not the reason: the
// gateway tolerates seconds of latency (heartbeats every ~41 s); the reasons are isolation from the
// API's lifecycle and footprint.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"slices"
	"strings"
	"syscall"
	"time"
)

var version = "0.1.0"

type gatewayBot struct {
	URL               string `json:"url"`
	Shards            int    `json:"shards"`
	SessionStartLimit struct {
		Remaining      int   `json:"remaining"`
		ResetAfter     int64 `json:"reset_after"`
		MaxConcurrency int   `json:"max_concurrency"`
	} `json:"session_start_limit"`
}

func fetchGatewayBot(ctx context.Context, s Settings) (gatewayBot, error) {
	var gb gatewayBot
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.DiscordAPI+"/gateway/bot", nil)
	if err != nil {
		return gb, err
	}
	req.Header.Set("Authorization", "Bot "+s.BotToken)
	req.Header.Set("User-Agent", "DiscordBot (https://github.com/Kitsuden/kitsuden-kons, "+version+")")
	res, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return gb, err
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusUnauthorized {
		return gb, fmt.Errorf("%w: Discord rejected DISCORD_BOT_TOKEN", errPermanent)
	}
	if res.StatusCode != http.StatusOK {
		return gb, fmt.Errorf("GET /gateway/bot: HTTP %d", res.StatusCode)
	}
	return gb, json.NewDecoder(res.Body).Decode(&gb)
}

// retry runs fn with exponential backoff until it works, ctx ends, or the error is permanent.
func retry[T any](ctx context.Context, log *slog.Logger, what string, fn func(context.Context) (T, error)) (T, error) {
	wait := time.Second
	for {
		v, err := fn(ctx)
		if err == nil || errors.Is(err, errPermanent) {
			return v, err
		}
		log.Warn(what+" failed; retrying", "err", err, "in", wait.String())
		select {
		case <-ctx.Done():
			return v, ctx.Err()
		case <-time.After(wait):
		}
		wait = min(wait*2, time.Minute)
	}
}

func healthcheck(addr string) int {
	if strings.HasPrefix(addr, ":") {
		addr = "127.0.0.1" + addr
	}
	res, err := (&http.Client{Timeout: 3 * time.Second}).Get("http://" + addr + "/healthz")
	if err != nil {
		return 1
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return 1
	}
	return 0
}

func main() {
	check := flag.Bool("healthcheck", false, "probe /healthz and exit 0/1 (for Docker HEALTHCHECK on scratch)")
	flag.Parse()

	if *check {
		addr := os.Getenv("HEALTH_ADDR")
		if addr == "" {
			addr = ":8081"
		}
		os.Exit(healthcheck(addr))
	}

	log := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: slog.LevelInfo}))
	settings, err := LoadSettings()
	if err != nil {
		log.Error("bad configuration", "err", err)
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	kon := NewKonClient(settings.APIURL, settings.APIToken)
	cfg, err := retry(ctx, log, "reading the kon's gateway config", kon.Config)
	if err != nil {
		log.Error("cannot read the gateway config from the kon", "err", err)
		os.Exit(1)
	}

	gb, err := retry(ctx, log, "GET /gateway/bot", func(c context.Context) (gatewayBot, error) {
		return fetchGatewayBot(c, settings)
	})
	if err != nil {
		log.Error("cannot reach the Discord gateway", "err", err)
		os.Exit(1)
	}
	if gb.SessionStartLimit.Remaining == 0 {
		wait := time.Duration(gb.SessionStartLimit.ResetAfter) * time.Millisecond
		log.Warn("Discord's daily session-start limit is used up; waiting", "for", wait.String())
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}

	count := settings.ShardCount
	if count == 0 {
		count = max(1, gb.Shards)
	}
	ids := settings.ShardIDs
	if len(ids) == 0 {
		for i := range count {
			ids = append(ids, i)
		}
	}
	if slices.ContainsFunc(ids, func(id int) bool { return id >= count }) {
		log.Error("DISCORD_SHARD_IDS has a shard outside DISCORD_SHARD_COUNT", "count", count, "ids", ids)
		os.Exit(2)
	}

	fwd := NewForwarder(kon, log, settings.BatchMax, settings.BufferSize, settings.BatchInterval)
	fwd.SetEvents(cfg.Events)
	gate := NewIdentifyGate(gb.SessionStartLimit.MaxConcurrency)

	shards := make([]*Shard, 0, len(ids))
	for _, id := range ids {
		shards = append(shards, NewShard(id, count, settings.BotToken, gb.URL, cfg.Intents, fwd, gate, log))
	}

	log.Info("starting", "version", version, "shards", ids, "shardCount", count,
		"intents", cfg.Intents, "events", cfg.Events)

	go fwd.Run(ctx)
	for _, s := range shards {
		go s.Run(ctx)
	}
	go serveHealth(ctx, settings.HealthAddr, shards, fwd, log)

	// Config poller: a module switched on or off changes the intents; identify again with them.
	revision := cfg.Revision
	ticker := time.NewTicker(settings.ConfigEvery)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			log.Info("shutting down")
			return
		case <-ticker.C:
			next, err := kon.Config(ctx)
			if err != nil {
				log.Warn("could not refresh the gateway config", "err", err)
				continue
			}
			if next.Revision == revision {
				continue
			}
			log.Info("gateway config changed", "intents", next.Intents, "events", next.Events)
			revision = next.Revision
			fwd.SetEvents(next.Events)
			for _, s := range shards {
				s.SetIntents(next.Intents)
			}
		}
	}
}
