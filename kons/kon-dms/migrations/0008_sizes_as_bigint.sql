-- 0008 — DMS: sizes as bigint (2026-10-27)
-- ============================================================================
-- Idempotent (changing a column that is already bigint to bigint does nothing).
--
-- `total_size_bytes` (version) and `size_bytes` (file) were `integer`: as soon
-- as a version added up to more than 2 GB, the upload that made it grow failed
-- with 22003 (out of range) and answered 400. `bigint` reaches 9 EB; Drizzle
-- reads them as a number (exact up to 9 PB).
--
-- The change from integer to bigint rewrites the table under an exclusive lock:
-- on a database with many files it is best applied off-hours.

ALTER TABLE "dms_document_versions" ALTER COLUMN "total_size_bytes" TYPE bigint;
ALTER TABLE "dms_document_files" ALTER COLUMN "size_bytes" TYPE bigint;
