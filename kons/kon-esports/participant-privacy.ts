/**
 * What comes out of a participant row depending on who asks
 * ============================================================================
 *
 * ── WHAT WAS HAPPENING ─────────────────────────────────────────────────────
 *
 * `publicParticipant()` (registration) already removed the email and the link hash
 * from its responses. But the two PUBLIC reads that return the list of
 * registrants —`GET /tournaments/:id` and `GET /matches/:id`— did
 * `...p.participant` with the whole row, without a session:
 *
 *   · `guestEmail`         the email of each guest of a 1v1,
 *   · `accessTokenHash`    the hash of their personal link,
 *   · `contactHandle`      the Discord handle the bot notifies through,
 *   · `registeredByUserId` the account behind each registrant,
 *   · `customData`         ALL the answers, including the `organizer` ones
 *                          (PayPal, phone, address).
 *
 * It is the same leak that the rule in `custom-fields.ts` claimed to close, through another
 * door. It is filtered here, in a single function, so that the next route that
 * shows registrants does not have to remember field by field.
 *
 * The organization sees everything EXCEPT the hash: it is no use to them (the token
 * cannot be reconstructed from it) and it is the only thing in the row nobody should copy.
 */

import { publicAnswers, type CustomFieldDefinition } from "./custom-fields";

type ParticipantLike = Record<string, unknown> & {
  customData?: unknown;
};

/** Fields only the organization sees. */
const PRIVATE_FIELDS = ["guestEmail", "contactHandle", "registeredByUserId"] as const;

export function participantForViewer<T extends ParticipantLike>(
  row: T,
  fields: CustomFieldDefinition[],
  staff: boolean
): Omit<T, "accessTokenHash"> {
  const { accessTokenHash: _hash, ...rest } = row as T & { accessTokenHash?: unknown };
  if (staff) return rest as Omit<T, "accessTokenHash">;

  const out: Record<string, unknown> = { ...rest };
  for (const key of PRIVATE_FIELDS) delete out[key];
  out.customData = publicAnswers(
    fields,
    ((row.customData ?? {}) as Record<string, string | number | boolean | null>) ?? {}
  );
  return out as Omit<T, "accessTokenHash">;
}
