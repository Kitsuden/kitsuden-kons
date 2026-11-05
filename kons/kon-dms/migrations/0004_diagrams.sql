-- DMS Kon - Phase 3 Migration
-- Embedded diagrams (draw.io / excalidraw)

CREATE TABLE IF NOT EXISTS dms_document_diagrams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    version_id UUID NOT NULL REFERENCES dms_document_versions(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    source_xml TEXT,
    source_json TEXT,
    rendered_svg TEXT,
    media_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS dms_diagrams_version_idx ON dms_document_diagrams(version_id);
