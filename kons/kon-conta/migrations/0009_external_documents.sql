-- 0009 — A document from another system is recorded once
-- ============================================================================
-- Idempotent (IF NOT EXISTS).
--
-- conta.connected.ts turns a confirmed Odoo sales order into an issued invoice, keyed
-- `source = 'odoo'`, `external_ref = 'odoo-so:<sale.order id>'`. It looks for the invoice before
-- creating it, but two deliveries of the same event can look at the same moment and both find
-- nothing. This index is what makes the second one fail instead of billing the order twice.
--
-- Partial on purpose: `external_ref` on invoices was never unique for the sources that existed
-- before (manual, wip, recurringFee, successFee), and installed databases may hold repeats there.
-- A source that means "this is another system's document" opts in by being listed here.

CREATE UNIQUE INDEX IF NOT EXISTS idx_conta_invoices_external_document
  ON conta_invoices (source, external_ref)
  WHERE source = 'odoo' AND external_ref IS NOT NULL;

-- A payment that came from another system carries that system's id in `reference`
-- (`odoo-payment:<account.payment id>`); the listener looks it up before recording.
CREATE INDEX IF NOT EXISTS idx_conta_payments_reference
  ON conta_invoice_payments (reference)
  WHERE reference IS NOT NULL;
