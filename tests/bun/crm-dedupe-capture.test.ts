/**
 * CRM deduplication and capture.
 *
 * Duplicates are not a cosmetic problem: they split the history in two,
 * count the opportunity twice in the funnel, and make the caller miss the
 * conversation a colleague had. And they appear on their own — a form with
 * the email in uppercase, a CSV, a row created by hand over the phone.
 *
 * What is tested here are the limits, which is where an automatic merge
 * does irreversible damage.
 */

import { describe, it, expect } from "bun:test";

import { planCapture } from "../../kons/kon-crm/crm.capture";
import {
  findDuplicates,
  normalizeEmail,
  normalizePhone,
  normalizeName,
  planMerge,
  scorePair,
  DUPLICATE_THRESHOLD,
  type ContactLike,
} from "../../kons/kon-crm/crm.dedupe";

const c = (extra: Partial<ContactLike> & { id: string }): ContactLike => ({
  firstName: "Ana",
  lastName: "López",
  email: "ana@example.com",
  phone: null,
  mobile: null,
  companyId: null,
  createdAt: new Date("2026-01-01"),
  ...extra,
});

describe("normalization", () => {
  it("the email compares ignoring case and spaces", () => {
    expect(normalizeEmail("  Ana@Example.COM ")).toBe("ana@example.com");
  });

  it("does NOT strip dots or + suffixes: it would merge different employees", () => {
    // Gmail ignores them; corporate servers do not. Treating `ana.lopez@` and
    // `analopez@` as the same person would join two real people.
    expect(normalizeEmail("ana.lopez@corp.com")).not.toBe(normalizeEmail("analopez@corp.com"));
  });

  it("the phone absorbs prefixes and separators", () => {
    const expected = "600123456";
    expect(normalizePhone("+34 600 123 456")).toBe(expected);
    expect(normalizePhone("0034600123456")).toBe(expected);
    expect(normalizePhone("600-123-456")).toBe(expected);
  });

  it("the name ignores accents and extra spaces", () => {
    expect(normalizeName("  Ana   LÓPEZ ")).toBe("ana lopez");
  });
});

describe("scoring", () => {
  it("the same email is practically certainty", () => {
    const p = scorePair(c({ id: "1" }), c({ id: "2", firstName: "Anita", lastName: "L." }));
    expect(p.rating).toBeGreaterThanOrEqual(DUPLICATE_THRESHOLD);
    expect(p.reasons).toContain("same email");
  });

  it("the phone ALONE does NOT reach the threshold", () => {
    // A switchboard, a couple or a reassigned company mobile make two
    // different people share a number. Merging them would be real damage.
    const p = scorePair(
      c({ id: "1", email: "ana@a.com", phone: "600123456" }),
      c({ id: "2", email: "luis@b.com", firstName: "Luis", lastName: "Pérez", phone: "600123456" })
    );
    expect(p.rating).toBeLessThan(DUPLICATE_THRESHOLD);
  });

  it("the same name at the same company is ALSO not enough", () => {
    // There are many "Juan García", and two at the same company is not unusual.
    const p = scorePair(
      c({ id: "1", email: "j1@a.com", firstName: "Juan", lastName: "García", companyId: "e-1" }),
      c({ id: "2", email: "j2@a.com", firstName: "Juan", lastName: "García", companyId: "e-1" })
    );
    expect(p.rating).toBeLessThan(DUPLICATE_THRESHOLD);
  });

  it("phone + name do exceed the threshold", () => {
    const p = scorePair(
      c({ id: "1", email: "ana@a.com", phone: "600123456" }),
      c({ id: "2", email: "ana.lopez@b.com", phone: "+34 600 123 456" })
    );
    expect(p.rating).toBeGreaterThanOrEqual(DUPLICATE_THRESHOLD);
  });
});

describe("search", () => {
  it("never returns itself", () => {
    const one = c({ id: "1" });
    expect(findDuplicates(one, [one])).toEqual([]);
  });

  it("sorts from most to least similar", () => {
    const r = findDuplicates(c({ id: "1", phone: "600123456" }), [
      c({ id: "2", email: "other@x.com", phone: "600123456" }),
      c({ id: "3" }), // same email: strongest
    ]);
    expect(r[0].id).toBe("3");
  });
});

describe("merge plan", () => {
  it("the OLDEST survives", () => {
    // It is the one with the long history hanging off it; keeping the new one would require
    // moving more things and losing more if something goes wrong.
    const p = planMerge(
      c({ id: "newer", createdAt: new Date("2026-06-01") }),
      c({ id: "viejo", createdAt: new Date("2025-01-01") })
    );
    expect(p.keep).toBe("viejo");
    expect(p.absorb).toBe("newer");
  });

  it("fills the survivor's gaps", () => {
    const p = planMerge(
      c({ id: "viejo", phone: null, createdAt: new Date("2025-01-01") }),
      c({ id: "newer", phone: "600123456", createdAt: new Date("2026-06-01") })
    );
    expect(p.filledFields.phone).toBe("600123456");
  });

  it("NEVER overwrites a value: it marks it as a conflict", () => {
    // Choosing silently here deletes the only good phone.
    const p = planMerge(
      c({ id: "viejo", phone: "600111111", createdAt: new Date("2025-01-01") }),
      c({ id: "newer", phone: "600222222", createdAt: new Date("2026-06-01") })
    );
    expect(p.filledFields.phone).toBeUndefined();
    expect(p.conflicts).toContainEqual({
      field: "phone",
      keep: "600111111",
      absorb: "600222222",
    });
  });
});

describe("capture from a form", () => {
  it("rejects without email", () => {
    const p = planCapture({ email: "", firstName: "Ana" });
    expect(p.action).toBe("reject");
  });

  it("rejects a submission with no name or message — smells like a bot", () => {
    const p = planCapture({ email: "x@y.com" });
    expect(p.action).toBe("reject");
  });

  it("creates when there are no matches", () => {
    const p = planCapture({ email: "new@x.com", firstName: "New" }, { existing: [] });
    expect(p.action).toBe("create");
  });

  it("UPDATES instead of duplicating if it already exists", () => {
    const p = planCapture(
      { email: "ANA@example.com", firstName: "Ana" },
      { existing: [c({ id: "c-1" })] }
    );
    expect(p.action).toBe("update");
    if (p.action === "update") expect(p.contactId).toBe("c-1");
  });

  it("on update it does NOT send the identity fields", () => {
    // Overwriting the good name with whatever someone typed quickly is a silent
    // loss.
    const p = planCapture(
      { email: "ana@example.com", firstName: "A." },
      { existing: [c({ id: "c-1" })] }
    );
    if (p.action === "update") {
      expect(p.contact.firstName).toBeUndefined();
      expect(p.contact.email).toBeUndefined();
    }
  });

  it("always leaves a trace of the origin", () => {
    const p = planCapture({
      email: "x@y.com",
      firstName: "X",
      source: "landing-bf",
      message: "Quiero info",
    });
    if (p.action !== "reject") {
      expect(p.activity.type).toBe("form_submission");
      expect(p.activity.description).toBe("Quiero info");
    }
  });

  it("creates an opportunity only if a pipeline and stage are requested", () => {
    const without = planCapture({ email: "x@y.com", firstName: "X" });
    if (without.action !== "reject") expect(without.deal).toBeUndefined();

    const withValue = planCapture(
      { email: "x@y.com", firstName: "X" },
      { pipelineId: "p-1", stageId: "s-1" }
    );
    if (withValue.action !== "reject") expect(withValue.deal?.pipelineId).toBe("p-1");
  });
});
