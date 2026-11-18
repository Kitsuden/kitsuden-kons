package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// KonClient talks to kon-dc over plain HTTP with an agent key. Every call goes through the
// API's authentication, scopes, rate limits and audit like any other client: the worker is an
// agent with two fine scopes, not a privileged side door.
type KonClient struct {
	base  string
	token string
	http  *http.Client
}

func NewKonClient(base, token string) *KonClient {
	return &KonClient{base: base, token: token, http: &http.Client{Timeout: 15 * time.Second}}
}

// errPermanent marks answers that retrying will not fix (bad key, missing scope, wrong contract).
var errPermanent = errors.New("permanent")

func (k *KonClient) do(ctx context.Context, method, path string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(buf)
	}
	req, err := http.NewRequestWithContext(ctx, method, k.base+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+k.token)
	req.Header.Set("User-Agent", "kitsuden-dc-gateway/0.1")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := k.http.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	payload, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode >= 300 {
		snippet := string(payload)
		if len(snippet) > 300 {
			snippet = snippet[:300]
		}
		err := fmt.Errorf("%s %s: HTTP %d: %s", method, path, res.StatusCode, snippet)
		switch res.StatusCode {
		case http.StatusUnauthorized, http.StatusForbidden, http.StatusNotFound, http.StatusUnprocessableEntity:
			return fmt.Errorf("%w: %v", errPermanent, err)
		}
		return err
	}
	if out != nil {
		return json.Unmarshal(payload, out)
	}
	return nil
}

func (k *KonClient) Config(ctx context.Context) (GatewayConfig, error) {
	var cfg GatewayConfig
	if err := k.do(ctx, http.MethodGet, "/api/dc/gateway/config", nil, &cfg); err != nil {
		return cfg, err
	}
	if cfg.Contract != ContractVersion {
		return cfg, fmt.Errorf("%w: kon speaks gateway contract %d, this worker %d", errPermanent, cfg.Contract, ContractVersion)
	}
	return cfg, nil
}

func (k *KonClient) Send(ctx context.Context, events []GatewayEventEnvelope) (GatewayIngestResult, error) {
	var res GatewayIngestResult
	err := k.do(ctx, http.MethodPost, "/api/dc/gateway/events",
		GatewayEventBatch{Contract: ContractVersion, Events: events}, &res)
	return res, err
}
