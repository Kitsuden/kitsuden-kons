-- ============================================================================
-- MIGRATION: CRM Builder Phase 1
-- Entity Configs + Time Tracking + Stage Validations
-- ============================================================================

-- ============================================================================
-- 1. ENTITY CONFIGS TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS crm_entity_configs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  kon_id TEXT NOT NULL,
  
  -- Identity
  entity_name TEXT NOT NULL,
  singular_label TEXT NOT NULL,
  plural_label TEXT NOT NULL,
  
  -- Features
  requires_contact BOOLEAN DEFAULT TRUE,
  requires_company BOOLEAN DEFAULT TRUE,
  allows_value BOOLEAN DEFAULT TRUE,
  allows_time_tracking BOOLEAN DEFAULT TRUE,
  
  -- Schema
  field_schema JSONB DEFAULT '[]',
  
  -- Pipeline reference
  default_pipeline_id TEXT REFERENCES crm_pipelines(id) ON DELETE SET NULL,
  
  -- Active
  is_active BOOLEAN DEFAULT TRUE,
  is_default BOOLEAN DEFAULT FALSE,
  
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  created_by TEXT
);

-- Index for querying by kon
CREATE INDEX idx_entity_configs_kon ON crm_entity_configs(kon_id);
CREATE INDEX idx_entity_configs_active ON crm_entity_configs(is_active);

-- ============================================================================
-- 2. EXTEND PIPELINE STAGES (Builder Features)
-- ============================================================================

-- Time tracking & SLA
ALTER TABLE crm_pipeline_stages 
  ADD COLUMN IF NOT EXISTS track_time_in_stage BOOLEAN DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS estimated_days INTEGER;

-- Validations & Automations
ALTER TABLE crm_pipeline_stages 
  ADD COLUMN IF NOT EXISTS entry_requirements JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS on_enter_actions JSONB DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS on_exit_actions JSONB DEFAULT '[]';

-- ============================================================================
-- 3. STAGE TRANSITIONS (Time Tracking)
-- ============================================================================

CREATE TABLE IF NOT EXISTS crm_stage_transitions (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  deal_id TEXT NOT NULL REFERENCES crm_deals(id) ON DELETE CASCADE,
  
  -- Stage movement
  from_stage_id TEXT REFERENCES crm_pipeline_stages(id),
  to_stage_id TEXT NOT NULL REFERENCES crm_pipeline_stages(id),
  
  -- Timing
  entered_at TIMESTAMP NOT NULL DEFAULT NOW(),
  exited_at TIMESTAMP,
  duration_minutes INTEGER,
  
  -- SLA tracking
  estimated_days INTEGER,
  was_on_time BOOLEAN,
  sla_breach BOOLEAN DEFAULT FALSE,
  
  -- Metadata
  moved_by TEXT,
  move_reason TEXT,
  validation_result JSONB DEFAULT '{}',
  
  created_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_stage_transitions_deal ON crm_stage_transitions(deal_id);
CREATE INDEX idx_stage_transitions_from_stage ON crm_stage_transitions(from_stage_id);
CREATE INDEX idx_stage_transitions_to_stage ON crm_stage_transitions(to_stage_id);
CREATE INDEX idx_stage_transitions_entered ON crm_stage_transitions(entered_at);
CREATE INDEX idx_stage_transitions_exited ON crm_stage_transitions(exited_at) WHERE exited_at IS NULL;

-- ============================================================================
-- 4. EXTEND DEALS (Entity Config Reference + Current Transition)
-- ============================================================================

ALTER TABLE crm_deals 
  ADD COLUMN IF NOT EXISTS entity_config_id TEXT REFERENCES crm_entity_configs(id),
  ADD COLUMN IF NOT EXISTS current_transition_id TEXT REFERENCES crm_stage_transitions(id);

CREATE INDEX idx_deals_entity_config ON crm_deals(entity_config_id);
CREATE INDEX idx_deals_current_transition ON crm_deals(current_transition_id);

-- ============================================================================
-- 5. DOCUMENTS TABLE (Phase 1 - Basic)
-- ============================================================================

CREATE TABLE IF NOT EXISTS crm_documents (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  deal_id TEXT NOT NULL REFERENCES crm_deals(id) ON DELETE CASCADE,
  
  -- Document info
  name TEXT NOT NULL,
  file_url TEXT NOT NULL,
  file_type TEXT,
  file_size INTEGER,
  
  -- Categorization
  document_type TEXT,
  category TEXT,
  
  -- Stage requirements
  required_for_stage_id TEXT REFERENCES crm_pipeline_stages(id),
  is_required BOOLEAN DEFAULT FALSE,
  was_required BOOLEAN DEFAULT FALSE,
  
  -- Version control
  version INTEGER DEFAULT 1,
  previous_version_id TEXT,
  
  -- Access control
  is_privileged BOOLEAN DEFAULT FALSE,
  confidential BOOLEAN DEFAULT FALSE,
  
  uploaded_by TEXT,
  uploaded_at TIMESTAMP DEFAULT NOW(),
  metadata JSONB DEFAULT '{}'
);

CREATE INDEX idx_documents_deal ON crm_documents(deal_id);
CREATE INDEX idx_documents_type ON crm_documents(document_type);
CREATE INDEX idx_documents_required_stage ON crm_documents(required_for_stage_id);
CREATE INDEX idx_documents_uploaded ON crm_documents(uploaded_at);

-- ============================================================================
-- 6. DEFAULT ENTITY CONFIG (Backwards Compatibility)
-- ============================================================================

-- Create a default entity config for existing deals
INSERT INTO crm_entity_configs (
  id, kon_id, entity_name, singular_label, plural_label,
  requires_contact, requires_company, allows_value, allows_time_tracking,
  field_schema, is_active, is_default
)
SELECT 
  'default-deal-' || COALESCE(organization_id, 'global'),
  'kon-crm',
  'deal',
  'Deal',
  'Deals',
  TRUE, TRUE, TRUE, TRUE,
  '[]'::jsonb,
  TRUE,
  TRUE
FROM crm_pipelines
WHERE is_default = TRUE
ON CONFLICT DO NOTHING;

-- Link existing deals to default entity config
UPDATE crm_deals d
SET entity_config_id = (
  SELECT id FROM crm_entity_configs 
  WHERE is_default = TRUE 
  LIMIT 1
)
WHERE entity_config_id IS NULL;

-- ============================================================================
-- 7. INITIAL STAGE TRANSITIONS (For existing deals)
-- ============================================================================

-- Create initial transition records for deals that don't have one
INSERT INTO crm_stage_transitions (
  deal_id, to_stage_id, entered_at, duration_minutes
)
SELECT 
  d.id,
  d.stage_id,
  d.created_at,
  NULL -- Still in this stage
FROM crm_deals d
WHERE NOT EXISTS (
  SELECT 1 FROM crm_stage_transitions st 
  WHERE st.deal_id = d.id
);

-- Update deals with their current transition
UPDATE crm_deals d
SET current_transition_id = (
  SELECT id FROM crm_stage_transitions
  WHERE deal_id = d.id AND exited_at IS NULL
  ORDER BY entered_at DESC
  LIMIT 1
)
WHERE current_transition_id IS NULL;

-- ============================================================================
-- 8. TRIGGER: Auto-calculate duration on transition exit
-- ============================================================================

CREATE OR REPLACE FUNCTION calculate_transition_duration()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.exited_at IS NOT NULL AND OLD.exited_at IS NULL THEN
    NEW.duration_minutes := EXTRACT(EPOCH FROM (NEW.exited_at - NEW.entered_at)) / 60;
    
    -- Check SLA if estimated_days is set
    IF NEW.estimated_days IS NOT NULL THEN
      NEW.was_on_time := NEW.duration_minutes <= (NEW.estimated_days * 24 * 60);
      NEW.sla_breach := NOT NEW.was_on_time;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_calculate_duration ON crm_stage_transitions;
CREATE TRIGGER trigger_calculate_duration
  BEFORE UPDATE ON crm_stage_transitions
  FOR EACH ROW
  EXECUTE FUNCTION calculate_transition_duration();

-- ============================================================================
-- 9. FUNCTION: Get deal timeline
-- ============================================================================

CREATE OR REPLACE FUNCTION get_deal_timeline(p_deal_id TEXT)
RETURNS TABLE (
  id TEXT,
  from_stage_id TEXT,
  from_stage_name TEXT,
  to_stage_id TEXT,
  to_stage_name TEXT,
  entered_at TIMESTAMP,
  exited_at TIMESTAMP,
  duration_minutes INTEGER,
  was_on_time BOOLEAN,
  sla_breach BOOLEAN,
  moved_by TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    st.id,
    st.from_stage_id,
    fs.name AS from_stage_name,
    st.to_stage_id,
    ts.name AS to_stage_name,
    st.entered_at,
    st.exited_at,
    st.duration_minutes,
    st.was_on_time,
    st.sla_breach,
    st.moved_by
  FROM crm_stage_transitions st
  LEFT JOIN crm_pipeline_stages fs ON st.from_stage_id = fs.id
  LEFT JOIN crm_pipeline_stages ts ON st.to_stage_id = ts.id
  WHERE st.deal_id = p_deal_id
  ORDER BY st.entered_at DESC;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- 10. FUNCTION: Get cycle time analytics
-- ============================================================================

CREATE OR REPLACE FUNCTION get_stage_cycle_times(
  p_pipeline_id TEXT,
  p_start_date TIMESTAMP DEFAULT NULL,
  p_end_date TIMESTAMP DEFAULT NULL
)
RETURNS TABLE (
  stage_id TEXT,
  stage_name TEXT,
  avg_duration_minutes NUMERIC,
  median_duration_minutes NUMERIC,
  min_duration_minutes INTEGER,
  max_duration_minutes INTEGER,
  deal_count BIGINT,
  sla_breach_count BIGINT,
  sla_breach_rate NUMERIC
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    ps.id AS stage_id,
    ps.name AS stage_name,
    ROUND(AVG(st.duration_minutes), 2) AS avg_duration_minutes,
    PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY st.duration_minutes) AS median_duration_minutes,
    MIN(st.duration_minutes) AS min_duration_minutes,
    MAX(st.duration_minutes) AS max_duration_minutes,
    COUNT(*) AS deal_count,
    COUNT(*) FILTER (WHERE st.sla_breach = TRUE) AS sla_breach_count,
    ROUND(
      COUNT(*) FILTER (WHERE st.sla_breach = TRUE) * 100.0 / NULLIF(COUNT(*), 0), 
      2
    ) AS sla_breach_rate
  FROM crm_stage_transitions st
  JOIN crm_pipeline_stages ps ON st.to_stage_id = ps.id
  WHERE ps.pipeline_id = p_pipeline_id
    AND st.exited_at IS NOT NULL
    AND (p_start_date IS NULL OR st.entered_at >= p_start_date)
    AND (p_end_date IS NULL OR st.entered_at <= p_end_date)
  GROUP BY ps.id, ps.name
  ORDER BY ps.order;
END;
$$ LANGUAGE plpgsql;

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================
