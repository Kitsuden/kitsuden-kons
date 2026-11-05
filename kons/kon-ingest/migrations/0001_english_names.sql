-- English names for kon-ingest: the public API and the database move to English.
--
-- It renames in place, so data is kept, and every step checks first: it works on a fresh chain,
-- on a database at the previous chain's state, and if a name was already changed by hand.

-- Policies that name something that changes: they come back in the next file.
DROP POLICY IF EXISTS ingest_chunks_delete ON ingest_chunks;
DROP POLICY IF EXISTS ingest_chunks_insert ON ingest_chunks;
DROP POLICY IF EXISTS ingest_chunks_select ON ingest_chunks;
DROP POLICY IF EXISTS ingest_chunks_update ON ingest_chunks;
DROP POLICY IF EXISTS ingest_documents_delete ON ingest_documents;
DROP POLICY IF EXISTS ingest_documents_insert ON ingest_documents;
DROP POLICY IF EXISTS ingest_documents_select ON ingest_documents;
DROP POLICY IF EXISTS ingest_documents_update ON ingest_documents;
