-- DMS Kon - Phase 2 Migration
-- Comments system for informal collaboration

CREATE TABLE IF NOT EXISTS dms_document_comments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES dms_documents(id) ON DELETE CASCADE,
    version_id UUID REFERENCES dms_document_versions(id) ON DELETE CASCADE,
    parent_id UUID REFERENCES dms_document_comments(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    content TEXT NOT NULL,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS dms_comments_document_idx ON dms_document_comments(document_id);
CREATE INDEX IF NOT EXISTS dms_comments_user_idx ON dms_document_comments(user_id);
CREATE INDEX IF NOT EXISTS dms_comments_parent_idx ON dms_document_comments(parent_id);
CREATE INDEX IF NOT EXISTS dms_comments_created_idx ON dms_document_comments(created_at DESC);
