/**
 * koe — Authorization
 * ============================================================================
 * Deny-by-default. Importing this module registers the "koe" policy.
 *
 * Two layers, like the rest of Kitsuden:
 *
 *   - the HTTP policy (here) lets a signed-in account or agent reach the inbox operations (`use`) and only
 *     koe admins reach the setup that holds credentials (`configure`);
 *   - who is a koe member, and which conversations each one sees, is row-level security in the migration
 *     (`koe_role()`, `koe_sees()`), and `requireMember()` below turns "not a member" into a clear 403.
 *
 * A Kitsuden admin is a koe admin. An agent key opens koe with `koe:*` (or `kon:koe:*`), or one operation
 * with its fine scope `kon:koe:<operation>`.
 */
import { actsAsUserIn, AppError, definePolicy, isEffectiveAdmin, type AuthzUser } from "@kitsuden/engine";
import { eq } from "drizzle-orm";

import type { Db } from "./koe.common";
import { koeMembers, type MemberRole } from "./koe.schema";

const signedIn = (u: AuthzUser | null) => !!u?.id && u.role !== "anonymous";

export function registerKoePolicy(): void {
  definePolicy("koe", {
    // A person who is signed in (membership is checked by requireMember and row security); an agent key
    // only with a koe scope or `user:act`: a key with no koe scope never reaches the inbox.
    use: (u) => signedIn(u) && actsAsUserIn("koe")(u as never),
    configure: (u) => isEffectiveAdmin(u, "koe"),
  });
}

registerKoePolicy();

export const USE = { policy: { resource: "koe", action: "use" } } as const;
export const CONFIGURE = { policy: { resource: "koe", action: "configure" } } as const;

export interface Member {
  userId: string;
  role: MemberRole;
  /** admin or supervisor. */
  lead: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the host's user object
type User = any;

/** The caller as a koe member, or 403. Kitsuden admins and agent keys that open koe are koe admins. */
export async function requireMember(db: Db, user: User): Promise<Member> {
  if (!user?.id) throw AppError.unauthenticated();
  if (isEffectiveAdmin(user, "koe")) return { userId: String(user.id), role: "admin", lead: true };
  const [m] = (await db.select({ role: koeMembers.role }).from(koeMembers).where(eq(koeMembers.userId, String(user.id))).limit(1)) as Array<{ role: MemberRole }>;
  if (!m) throw AppError.forbidden("You are not on the koe team. Ask an admin to add you.");
  return { userId: String(user.id), role: m.role, lead: m.role === "admin" || m.role === "supervisor" };
}

export async function requireLead(db: Db, user: User): Promise<Member> {
  const m = await requireMember(db, user);
  if (!m.lead) throw AppError.forbidden("Only a supervisor or an admin can do this");
  return m;
}
