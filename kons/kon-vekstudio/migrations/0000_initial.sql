-- kon-ocr — Initial migration
-- Mirror/link table for konusagi's OCR jobs.
-- The pipeline's source of truth lives in konusagi's Postgres
-- (table ocr_jobs); here it is only correlated with KITSUDEN entities.

CREATE TABLE IF NOT EXISTS ocr_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id VARCHAR(64) NOT NULL UNIQUE,
    filename TEXT,
    state VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    engine VARCHAR(64),
    confidence DOUBLE PRECISION,
    processing_time_ms INTEGER,
    error TEXT,
    entity_type VARCHAR(64),
    entity_id VARCHAR(64),
    reviewed BOOLEAN NOT NULL DEFAULT false,
    created_by VARCHAR(64),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ocr_documents_state_idx ON ocr_documents(state);
CREATE INDEX IF NOT EXISTS ocr_documents_entity_idx ON ocr_documents(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS ocr_documents_created_idx ON ocr_documents(created_at DESC);
