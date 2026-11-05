-- DMS Kon - Phase 1 Migration
-- slug history + full-text search index

-- 1. Slug history table for permanent redirects
CREATE TABLE IF NOT EXISTS dms_document_slug_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES dms_documents(id) ON DELETE CASCADE,
    old_slug VARCHAR(500) NOT NULL,
    changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS dms_slug_history_old_slug_idx ON dms_document_slug_history(old_slug);
CREATE INDEX IF NOT EXISTS dms_slug_history_document_idx ON dms_document_slug_history(document_id);

-- 2. Full-text search index on version content (Spanish)
CREATE INDEX IF NOT EXISTS dms_versions_content_fts_idx 
ON dms_document_versions 
USING GIN (to_tsvector('spanish', COALESCE(content, '')));

-- 3. Full-text search index on document files extracted text
CREATE INDEX IF NOT EXISTS dms_files_extracted_text_fts_idx 
ON dms_document_files 
USING GIN (to_tsvector('spanish', COALESCE(extracted_text, '')));
