-- kon-ocr-training — vision LLM config (governed by KITSUDEN)
-- Only NON-sensitive knobs: the provider API key lives in KITSUDEN Secrets
-- (table kitsuden_secrets, encrypted with AES-256-GCM), never here.

CREATE TABLE IF NOT EXISTS ocr_vision_config (
    id INTEGER PRIMARY KEY DEFAULT 1,
    enabled BOOLEAN NOT NULL DEFAULT false,
    provider VARCHAR(32) NOT NULL DEFAULT 'anthropic',
    model VARCHAR(128),
    base_url TEXT,
    min_confidence DOUBLE PRECISION,
    stage VARCHAR(16) NOT NULL DEFAULT 'after_heavy',
    max_pages INTEGER NOT NULL DEFAULT 3,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by VARCHAR(64),
    CONSTRAINT ocr_vision_config_singleton CHECK (id = 1)
);
