/** What the CRM routes this panel calls answer, as far as the panel reads them. */

export interface ScoreRule {
  id?: string;
  label?: string;
  signal?: string;
  op?: string;
  value?: string | number | boolean;
  points?: number;
}

export interface ScoreModel {
  version: number;
  guide?: string | null;
  rules?: ScoreRule[];
  /** Signal key → what it means. */
  signals?: Record<string, string>;
}

export interface ScorePreview {
  score: number;
  matched: { label: string; points: number }[];
}

export interface EvidenceKind {
  key: string;
  label: string;
  weight: number;
  active?: boolean;
  description?: string | null;
}

export interface EvidencePolicy {
  applyAt: number;
  kinds: EvidenceKind[];
}

export interface Grant {
  subjectType: "user" | "agent";
  subjectId: string;
  records: "all" | "assigned";
  money: boolean;
  sensitive: boolean;
  notes?: boolean | null;
  sensitiveUntil?: string | null;
  reason: string;
}

export interface Preset {
  id: string;
  name: string;
  description: string;
}

export interface PresetResult {
  created: string[];
  conta?: boolean;
  profiles?: { profile: string; records: string; money: boolean; sensitive: boolean }[];
  nextSteps?: string[];
}

export interface Stage {
  id: string;
  name: string;
}

export interface Pipeline {
  id: string;
  name: string;
  stages?: Stage[];
}

export interface CaptureForm {
  id: string;
  name: string;
  source?: string | null;
  pipelineId?: string | null;
  stageId?: string | null;
  active: boolean;
}

export interface DocumentTemplate {
  id: string;
  name: string;
  description?: string | null;
  body: string;
  active: boolean;
}

export interface RenderedTemplate {
  content: string;
  missing: string[];
}

export interface PortalLink {
  id: string;
  contactId: string;
  expiresAt: string;
  live: boolean;
  revokedAt?: string | null;
}
