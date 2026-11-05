/**
 * Lead capture from a form
 * ============================================================================
 *
 * The hole it closes: until now the CRM knew how to manage what it already had
 * inside, but nothing came in on its own. Someone typed by hand what arrived by
 * email — and what is typed by hand is typed differently each time, which is
 * exactly how duplicates are born.
 *
 * ── WHAT IT DOES AND WHAT IT DOES NOT ──────────────────────────────────────
 *
 * It returns a PLAN, it does not write. The caller decides whether to run it, because a public
 * capture is a surface a bot can hammer: without that
 * control, every submission would create a row.
 *
 * And it reuses the duplicate detector instead of always creating: a form
 * filled in twice by the same person must not produce two contacts.
 */

import {
  findDuplicates,
  normalizeEmail,
  normalizePhone,
  type Candidate,
  type ContactLike,
} from "./crm.dedupe";

export interface FormSubmission {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  companyName?: string | null;
  message?: string | null;
  /** Where it came from: `web`, `landing-black-friday`, `evento-madrid`… */
  source?: string | null;
  campaign?: string | null;
  /** Any extra form field. It is stored as is. */
  extra?: Record<string, unknown>;
}

export type CapturePlan =
  | { action: "reject"; reasons: string[] }
  | {
      action: "create" | "update";
      /** Only in `update`: who it is attributed to. */
      contactId?: string;
      /** Matches found, to show why. */
      matches: Candidate[];
      contact: Record<string, unknown>;
      /** Activity to record. A lead with no trace of its origin is useless. */
      activity: Record<string, unknown>;
      /** Suggested deal, if its creation was requested. */
      deal?: Record<string, unknown>;
    };

export interface CaptureOptions {
  /** Also create a deal in this pipeline. */
  pipelineId?: string;
  stageId?: string;
  /** Deal title. By default, the name or the email. */
  dealTitle?: string;
  /** Existing contacts to check duplicates against. */
  existing?: ContactLike[];
}

/** Very basic on purpose: rejecting a valid email is worse than accepting garbage. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Converts a form submission into a plan.
 *
 * Validation is deliberately lax except for the email: it is the only key
 * that allows deduplicating afterward, and without it the lead is unusable.
 */
export function planCapture(
  dispatch: FormSubmission,
  options: CaptureOptions = {}
): CapturePlan {
  const reasons: string[] = [];

  const email = normalizeEmail(dispatch.email);
  if (!email) reasons.push("The email is missing.");
  else if (!EMAIL_RE.test(email)) reasons.push("The email is not valid.");

  // A form with NO human data at all is usually a bot. It is not blocked for
  // that alone — some forms only ask for an email — but it is if in addition the
  // message is empty and there is no name.
  if (!dispatch.firstName && !dispatch.lastName && !dispatch.message) {
    reasons.push("The submission has no name or message.");
  }

  if (reasons.length > 0) return { action: "reject", reasons };

  const candidate: ContactLike = {
    id: "__new__",
    firstName: dispatch.firstName ?? null,
    lastName: dispatch.lastName ?? null,
    email,
    phone: normalizePhone(dispatch.phone) || null,
  };

  const matches = findDuplicates(candidate, options.existing ?? []);
  const existing = matches[0];

  const contact: Record<string, unknown> = {
    firstName: dispatch.firstName ?? "",
    lastName: dispatch.lastName ?? "",
    email,
    phone: dispatch.phone ?? null,
    source: dispatch.source ?? "form",
    campaign: dispatch.campaign ?? null,
  };

  // In `update` the identity fields are NOT sent: overwriting a contact's good name
  // with what someone typed quickly into a form is a
  // silent loss. Only what was missing is added.
  if (existing) {
    for (const k of ["firstName", "lastName", "email"]) delete contact[k];
  }

  const name = [dispatch.firstName, dispatch.lastName].filter(Boolean).join(" ") || email;

  const activity: Record<string, unknown> = {
    type: "form_submission",
    subject: `Form: ${dispatch.source ?? "web"}`,
    description: dispatch.message ?? null,
    metadata: { ...(dispatch.extra ?? {}), source: dispatch.source, campaign: dispatch.campaign },
  };

  const plan: CapturePlan = existing
    ? { action: "update", contactId: existing.id, matches, contact, activity }
    : { action: "create", matches, contact, activity };

  if (options.pipelineId && options.stageId) {
    plan.deal = {
      title: options.dealTitle ?? `Inquiry from ${name}`,
      pipelineId: options.pipelineId,
      stageId: options.stageId,
      source: dispatch.source ?? "form",
      campaign: dispatch.campaign ?? null,
      value: 0,
    };
  }

  return plan;
}
