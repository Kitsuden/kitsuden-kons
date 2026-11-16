package main

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

// Settings come from the environment only. Nothing here is written to disk or logged.
type Settings struct {
	BotToken      string        // DISCORD_BOT_TOKEN
	APIURL        string        // KITSUDEN_API_URL, e.g. http://kitsuden_api:3000
	APIToken      string        // KITSUDEN_API_TOKEN: agent key with the kon's two gateway scopes
	ShardCount    int           // DISCORD_SHARD_COUNT: 0 = what Discord recommends
	ShardIDs      []int         // DISCORD_SHARD_IDS: "0,1" = only these (several workers); empty = all
	ConfigEvery   time.Duration // CONFIG_POLL_SECONDS (default 60)
	HealthAddr    string        // HEALTH_ADDR (default :8081)
	DiscordAPI    string        // DISCORD_API_BASE (default https://discord.com/api/v10)
	BatchMax      int           // BATCH_MAX (default 50, max 100: the kon's limit)
	BatchInterval time.Duration // BATCH_INTERVAL_MS (default 250)
	BufferSize    int           // BUFFER_SIZE (default 10000 events held while the API is down)
}

func envInt(name string, def int) (int, error) {
	v := strings.TrimSpace(os.Getenv(name))
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("%s must be a non-negative integer", name)
	}
	return n, nil
}

func LoadSettings() (Settings, error) {
	s := Settings{
		BotToken:   strings.TrimSpace(os.Getenv("DISCORD_BOT_TOKEN")),
		APIURL:     strings.TrimRight(strings.TrimSpace(os.Getenv("KITSUDEN_API_URL")), "/"),
		APIToken:   strings.TrimSpace(os.Getenv("KITSUDEN_API_TOKEN")),
		HealthAddr: strings.TrimSpace(os.Getenv("HEALTH_ADDR")),
		DiscordAPI: strings.TrimRight(strings.TrimSpace(os.Getenv("DISCORD_API_BASE")), "/"),
	}
	if s.BotToken == "" {
		return s, errors.New("DISCORD_BOT_TOKEN is required")
	}
	if s.APIURL == "" {
		return s, errors.New("KITSUDEN_API_URL is required")
	}
	if s.APIToken == "" {
		return s, errors.New("KITSUDEN_API_TOKEN is required (an agent key with kon:dc:gateway-config and kon:dc:ingest-gateway-events)")
	}
	if s.HealthAddr == "" {
		s.HealthAddr = ":8081"
	}
	if s.DiscordAPI == "" {
		s.DiscordAPI = "https://discord.com/api/v10"
	}

	var err error
	if s.ShardCount, err = envInt("DISCORD_SHARD_COUNT", 0); err != nil {
		return s, err
	}
	poll, err := envInt("CONFIG_POLL_SECONDS", 60)
	if err != nil {
		return s, err
	}
	if poll < 10 {
		poll = 10
	}
	s.ConfigEvery = time.Duration(poll) * time.Second
	if s.BatchMax, err = envInt("BATCH_MAX", 50); err != nil {
		return s, err
	}
	if s.BatchMax < 1 || s.BatchMax > 100 {
		s.BatchMax = 50
	}
	ms, err := envInt("BATCH_INTERVAL_MS", 250)
	if err != nil {
		return s, err
	}
	s.BatchInterval = time.Duration(max(ms, 50)) * time.Millisecond
	if s.BufferSize, err = envInt("BUFFER_SIZE", 10000); err != nil {
		return s, err
	}
	if s.BufferSize < 100 {
		s.BufferSize = 100
	}

	if raw := strings.TrimSpace(os.Getenv("DISCORD_SHARD_IDS")); raw != "" {
		for _, part := range strings.Split(raw, ",") {
			id, err := strconv.Atoi(strings.TrimSpace(part))
			if err != nil || id < 0 {
				return s, errors.New("DISCORD_SHARD_IDS must be a comma-separated list of shard numbers")
			}
			s.ShardIDs = append(s.ShardIDs, id)
		}
	}
	return s, nil
}
