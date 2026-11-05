-- Deleting a document deletes its chunks, in the same statement's transaction.
--
-- `ingest_chunks.document_id` is text while `ingest_documents.id` is uuid, so a foreign key
-- would need a type change; a trigger does the same job on any delete path (the API, an
-- admin, plain SQL). It runs as the caller, so row security still applies to the chunks.

-- Chunks left behind by deletes before this migration.
DELETE FROM ingest_chunks c
WHERE NOT EXISTS (SELECT 1 FROM ingest_documents d WHERE d.id::text = c.document_id);

CREATE OR REPLACE FUNCTION kon_ingest_delete_document_chunks()
RETURNS TRIGGER AS $$
BEGIN
  DELETE FROM ingest_chunks WHERE document_id = OLD.id::text;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ingest_documents_delete_chunks ON ingest_documents;
CREATE TRIGGER ingest_documents_delete_chunks
  AFTER DELETE ON ingest_documents
  FOR EACH ROW EXECUTE FUNCTION kon_ingest_delete_document_chunks();
