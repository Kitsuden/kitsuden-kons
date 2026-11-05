/**
 * Duplicate detection and merging
 * ============================================================================
 *
 * WHY IT MATTERS MORE THAN ANY OTHER CRM FUNCTION
 *
 * Two rows for the same person are not a cosmetic problem: they corrupt everything
 * built on top. The activity history is split in two, the
 * funnel counts the deal twice, and whoever phones does not see the
 * conversation their colleague had last week.
 *
 * And they appear on their own: a form capture with the email in uppercase,
 * a CSV import, a contact created by hand while the customer
 * waited on the phone.
 *
 * ── WHAT THIS MODULE DOES NOT DO ───────────────────────────────────────────
 *
 * It does not merge on its own. It returns CANDIDATES with a score and a plan;
 * deciding is for whoever looks. Automatically merging two different people
 * who share a company phone is damage that cannot be undone, and trust
 * in the CRM is lost the first time.
 */

// ── Normalization ───────────────────────────────────────────────────────────

/**
 * Normalizes an email for comparison.
 *
 * Only lowercase and whitespace: dots and `+something` suffixes are NOT removed. Gmail
 * ignores them, but most corporate servers do not, and treating
 * `ana.lopez@` and `analopez@` as the same person would merge two different
 * employees at more than one company.
 */
export function normalizeEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

/**
 * Keeps only the digits and takes the last 9.
 *
 * `+34 600 123 456`, `0034600123456` and `600123456` are the same number written
 * by three different people. Comparing the last 9 digits absorbs international
 * prefixes and separators without needing a telephony library.
 */
export function normalizePhone(tel: string | null | undefined): string {
  const digits = (tel ?? "").replace(/\D/g, "");
  return digits.length >= 9 ? digits.slice(-9) : digits;
}

/** Lowercase, accent-free and with collapsed whitespace. */
export function normalizeName(name: string | null | undefined): string {
  return (name ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ");
}

// ── Detection ───────────────────────────────────────────────────────────────

/** Minimal shape of a contact. Structural: it does not matter where it comes from. */
export interface ContactLike {
  id: string;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  companyId?: string | null;
  createdAt?: Date | string | null;
}

export interface Candidate {
  id: string;
  /** 0–100. Above 90 it is practically certain. */
  rating: number;
  /** What matched, so whoever decides sees why. */
  reasons: string[];
}

/**
 * Scores how similar two contacts are.
 *
 * The weights are not arbitrary:
 *
 * - **Same email = 90.** It is the strongest identifier in a CRM;
 *   two people do not share a mailbox.
 * - **Same phone = 45**, and no more. A company switchboard, a couple or
 *   a reassigned company mobile make two different people share a
 *   number. The phone alone does NOT reach the threshold: something more is needed.
 * - **Same full name = 40.** There are many "Juan García"s.
 * - **Same company = 10**, only as reinforcement.
 *
 * The same name at the same company adds up to 50 and still does not reach the threshold:
 * namesakes exist and merging them would be worse than leaving them apart.
 */
export function scorePair(a: ContactLike, b: ContactLike): Candidate {
  const reasons: string[] = [];
  let score = 0;

  const emailA = normalizeEmail(a.email);
  const emailB = normalizeEmail(b.email);
  if (emailA && emailA === emailB) {
    score += 90;
    reasons.push("same email");
  }

  const telsA = new Set(
    [normalizePhone(a.phone), normalizePhone(a.mobile)].filter(Boolean)
  );
  const telsB = new Set(
    [normalizePhone(b.phone), normalizePhone(b.mobile)].filter(Boolean)
  );
  if ([...telsA].some((t) => telsB.has(t))) {
    score += 45;
    reasons.push("same phone");
  }

  const nameA = normalizeName(`${a.firstName ?? ""} ${a.lastName ?? ""}`);
  const nameB = normalizeName(`${b.firstName ?? ""} ${b.lastName ?? ""}`);
  if (nameA && nameA === nameB) {
    score += 40;
    reasons.push("same name");
  }

  if (a.companyId && a.companyId === b.companyId) {
    score += 10;
    reasons.push("same company");
  }

  return { id: b.id, rating: Math.min(score, 100), reasons };
}

/** Default threshold. Below it, review is suggested; above it, merge. */
export const DUPLICATE_THRESHOLD = 85;

/**
 * Looks for duplicates of a contact within a set.
 *
 * Returns them sorted from most to least similar and never includes the contact itself.
 */
export function findDuplicates(
  contact: ContactLike,
  candidates: ContactLike[],
  threshold: number = DUPLICATE_THRESHOLD
): Candidate[] {
  return candidates
    .filter((c) => c.id !== contact.id)
    .map((c) => scorePair(contact, c))
    .filter((c) => c.rating >= threshold)
    .sort((a, b) => b.rating - a.rating);
}

// ── Merge ───────────────────────────────────────────────────────────────────

export interface PlanFusion {
  /** The one that survives. */
  keep: string;
  /** The one that is absorbed. */
  absorb: string;
  /** Fields the survivor gains from the absorbed one. */
  filledFields: Record<string, unknown>;
  /** Fields with a value in BOTH and different. A person decides them. */
  conflicts: Array<{ field: string; keep: unknown; absorb: unknown }>;
}

const MERGEABLE_FIELDS = [
  "firstName",
  "lastName",
  "email",
  "phone",
  "mobile",
  "jobTitle",
  "companyId",
  "linkedin",
  "twitter",
  "address",
  "city",
  "country",
  "notes",
] as const;

/**
 * Computes what would happen on merging, WITHOUT touching anything.
 *
 * Two rules:
 *
 * 1. **The oldest survives.** It is the one that probably has the long history,
 *    activities and deals hanging from it. Keeping the new one would mean moving more things
 *    and losing more if something goes wrong.
 * 2. **A gap is filled; a value is NEVER overwritten.** If the survivor has a
 *    phone and the absorbed one has another, that is a CONFLICT that is shown —
 *    not silently picked. Choosing wrong here erases the only good phone.
 */
export function planMerge(a: ContactLike, b: ContactLike): PlanFusion {
  const date = (c: ContactLike) => new Date(c.createdAt ?? 0).getTime();
  const [keep, absorb] = date(a) <= date(b) ? [a, b] : [b, a];

  const filledFields: Record<string, unknown> = {};
  const conflicts: PlanFusion["conflicts"] = [];

  for (const field of MERGEABLE_FIELDS) {
    // `ContactLike` declares only the structural minimum; the mergeable fields
    // may come from a richer contact. The double cast makes it explicit.
    const vC = (keep as unknown as Record<string, unknown>)[field];
    const vA = (absorb as unknown as Record<string, unknown>)[field];

    const empty = (v: unknown) => v === null || v === undefined || v === "";

    if (empty(vA)) continue;
    if (empty(vC)) {
      filledFields[field] = vA;
    } else if (vC !== vA) {
      conflicts.push({ field, keep: vC, absorb: vA });
    }
  }

  return { keep: keep.id, absorb: absorb.id, filledFields, conflicts };
}
