-- DMS Kon - Workflow Notifications Migration
-- Quick Win: notification system for the approval workflow

CREATE TABLE IF NOT EXISTS dms_workflow_notifications (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES dms_documents(id) ON DELETE CASCADE,
    version_id UUID REFERENCES dms_document_versions(id) ON DELETE CASCADE,
    user_id UUID NOT NULL,
    type VARCHAR(50) NOT NULL,
    message TEXT NOT NULL,
    read BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS dms_notifications_document_idx ON dms_workflow_notifications(document_id);
CREATE INDEX IF NOT EXISTS dms_notifications_user_idx ON dms_workflow_notifications(user_id);
CREATE INDEX IF NOT EXISTS dms_notifications_read_idx ON dms_workflow_notifications(read);
CREATE INDEX IF NOT EXISTS dms_notifications_created_idx ON dms_workflow_notifications(created_at DESC);
