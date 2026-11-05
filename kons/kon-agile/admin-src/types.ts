/** What the kon's routes return, as far as the panel reads it. */

export interface List<T> {
  docs: T[];
  totalDocs?: number;
}

export type Role = "owner" | "member" | "viewer";
export type StateGroup = "backlog" | "unstarted" | "started" | "completed" | "cancelled";

export interface ProjectConfig {
  estimateType?: string;
  timezone?: string;
  weekStartDay?: number;
  autoAssign?: Record<string, string>;
  autoArchiveDays?: number | null;
  autoCloseCycles?: boolean;
}

export interface Project {
  id: string;
  name: string;
  identifier: string;
  description?: string | null;
  emoji?: string | null;
  color?: string | null;
  isArchived: boolean;
  leadId?: string | null;
  defaultAssigneeId?: string | null;
  createdBy?: string | null;
  config?: ProjectConfig | null;
  states?: State[];
}

export interface Member {
  userId: string;
  role: Role;
  isAgent: boolean;
  createdAt?: string;
}

export interface Validations {
  requireAssignee?: boolean;
  requireEstimate?: boolean;
  requireDescription?: boolean;
}

export interface State {
  id: string;
  name: string;
  description?: string | null;
  group: StateGroup;
  color?: string | null;
  sequence: number;
  isDefault?: boolean;
  validations?: Validations | null;
}

export interface Label {
  id: string;
  name: string;
  description?: string | null;
  color?: string | null;
}

export interface EstimatePoint {
  value: number;
  label: string;
  color?: string;
}

export interface Estimate {
  id: string;
  name: string;
  type: string;
  customPoints?: EstimatePoint[] | null;
  isDefault?: boolean;
}

export interface CustomField {
  id: string;
  key: string;
  name: string;
  type: string;
  options?: string[] | null;
  isRequired: boolean;
  sortOrder: number;
}

export interface Cycle {
  id: string;
  name: string;
  description?: string | null;
  goal?: string | null;
  capacity?: number | null;
  startDate: string;
  endDate: string;
  status: string;
  isActive?: boolean;
  completedAt?: string | null;
}

export interface Module {
  id: string;
  name: string;
  description?: string | null;
  status: string;
  color?: string | null;
  leadId?: string | null;
  startDate?: string | null;
  targetDate?: string | null;
  initiativeId?: string | null;
}

export interface Initiative {
  id: string;
  name: string;
  description?: string | null;
  status: string;
  leadId?: string | null;
  color?: string | null;
  startDate?: string | null;
  targetDate?: string | null;
  issues?: { total: number; completed: number };
  pace?: { status: string } | string | null;
}

export interface Squad {
  id: string;
  name: string;
  description?: string | null;
  scrumMasterId?: string | null;
  memberIds: string[];
}

export interface Schedule {
  id: string;
  agentId: string;
  name: string;
  prompt: string;
  intervalMinutes: number;
  isActive: boolean;
  lastRunAt?: string | null;
  nextRunAt?: string | null;
}

export interface Intake {
  id: string;
  title: string;
  description?: string | null;
  status: string;
  source?: string | null;
  suggestedType?: string | null;
  suggestedPriority?: string | null;
  createdIssueKey?: string | null;
  createdAt: string;
}

export interface Work {
  id: string;
  agentId: string;
  trigger: string;
  status: string;
  prompt?: string | null;
  result?: string | null;
  issueKey?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  costUsd?: string | number | null;
  createdAt: string;
  finishedAt?: string | null;
}

export interface AgentTotals {
  agentId: string;
  queued: number;
  running: number;
  done: number;
  failed: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface Issue {
  id: string;
  key: string;
  name: string;
  priority?: string | null;
  stateId?: string | null;
  stateName?: string | null;
  stateColor?: string | null;
  stateGroup?: string | null;
  assigneeId?: string | null;
  archivedAt?: string | null;
  createdAt: string;
}

export interface Activity {
  id: string;
  actorId: string;
  action: string;
  entityType?: string | null;
  field?: string | null;
  oldValue?: unknown;
  newValue?: unknown;
  description?: string | null;
  issueId?: string | null;
  createdAt: string;
}

export const STATE_GROUPS: StateGroup[] = ["backlog", "unstarted", "started", "completed", "cancelled"];
export const ROLES: Role[] = ["owner", "member", "viewer"];
export const ESTIMATE_TYPES = ["fibonacci", "linear", "tshirt", "days", "points"];
export const FIELD_TYPES = ["text", "number", "date", "select", "multi_select", "checkbox", "user", "url"];
export const CYCLE_STATUSES = ["draft", "started", "completed", "cancelled"];
export const MODULE_STATUSES = ["backlog", "planned", "in_progress", "paused", "completed", "cancelled"];
export const INITIATIVE_STATUSES = ["planned", "active", "completed", "cancelled"];
export const PRIORITIES = ["urgent", "high", "medium", "low"];
export const WORK_STATUSES = ["queued", "running", "done", "failed", "cancelled"];
export const INTAKE_STATUSES = ["pending", "accepted", "declined", "duplicate", "spam"];
