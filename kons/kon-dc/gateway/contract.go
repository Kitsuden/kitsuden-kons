package main

// The wire between this worker and kon-dc. The source of truth is the zod schemas in
// ../dc.contract.ts; contract/*.schema.json is their JSON Schema, committed here.
// tests/unit/kon-dc-contract.test.ts (in the kons repository) fails when a `json:"..."` tag
// below and those schemas disagree. Change the zod first, regenerate, then these structs.

import "encoding/json"

// ContractVersion is GATEWAY_CONTRACT_VERSION in dc.contract.ts.
const ContractVersion = 1

// GatewayConfig is GET /api/dc/gateway/config.
type GatewayConfig struct {
	Contract int      `json:"contract"`
	Intents  int      `json:"intents"`
	Events   []string `json:"events"`
	Revision string   `json:"revision"`
}

// GatewayEventEnvelope is one dispatch as forwarded to the kon.
type GatewayEventEnvelope struct {
	T          string          `json:"t"`
	S          int64           `json:"s"`
	Shard      [2]int          `json:"shard"`
	ReceivedAt string          `json:"receivedAt"`
	D          json.RawMessage `json:"d"`
}

// GatewayEventBatch is the body of POST /api/dc/gateway/events.
type GatewayEventBatch struct {
	Contract int                    `json:"contract"`
	Events   []GatewayEventEnvelope `json:"events"`
}

// GatewayIngestResult is what the kon answers to a batch.
type GatewayIngestResult struct {
	Accepted int `json:"accepted"`
	Dropped  int `json:"dropped"`
}
