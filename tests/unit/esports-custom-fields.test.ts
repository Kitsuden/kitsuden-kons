/**
 * Custom registration fields
 * ============================================================================
 *
 * Online the TO cannot ask in person: they need the Riot ID, the region or
 * the deck list BEFORE, or the tournament is spent chasing people in private.
 *
 * What is pinned here is what turns a form into a problem:
 *
 *   · An `organizer` field (PayPal, phone) ends up in the PUBLIC list.
 *   · A dropdown accepts any text as soon as someone calls by hand.
 *   · A `url` field accepts `javascript:` and the TO's panel renders it.
 *   · Two fields with the same key and an answer lost without warning.
 */

import { describe, expect, test } from "vitest";

import {
  publicAnswers,
  validateAnswers,
  validateFieldDefinitions,
  type CustomFieldDefinition,
} from "../../kons/kon-esports/custom-fields";

const field = (over: Partial<CustomFieldDefinition>): CustomFieldDefinition => ({
  key: "riot_id",
  label: "Riot ID",
  type: "text",
  ...over,
});

// ── Definition ───────────────────────────────────────────────────────────────

describe("defining the fields", () => {
  test("a healthy definition gives no problems", () => {
    expect(
      validateFieldDefinitions([field({}), field({ key: "region", label: "Región" })])
    ).toEqual([]);
  });

  test("a DUPLICATE key is detected", () => {
    // The second would overwrite the first and an answer would be lost without anyone
    // noticing until it is needed.
    const issues = validateFieldDefinitions([field({}), field({ label: "Other" })]);
    expect(issues.join(" ")).toMatch(/Duplicate key/);
  });

  test("a key with an odd format is rejected", () => {
    expect(validateFieldDefinitions([field({ key: "mi campo" })]).length).toBeGreaterThan(0);
    expect(validateFieldDefinitions([field({ key: "1campo" })]).length).toBeGreaterThan(0);
  });

  test("a dropdown with fewer than two options is not a dropdown", () => {
    const issues = validateFieldDefinitions([
      field({ type: "select", options: ["EU"], key: "region" }),
    ]);
    expect(issues.join(" ")).toMatch(/at least two options/);
  });

  test("a number with the minimum above the maximum is detected", () => {
    const issues = validateFieldDefinitions([field({ type: "number", min: 10, max: 2 })]);
    expect(issues.join(" ")).toMatch(/minimum above the maximum/);
  });

  test("an endless form is cut off", () => {
    // Nobody fills in more than twenty fields: it is a way of losing people.
    const many = Array.from({ length: 25 }, (_, i) => field({ key: `f${i}` }));
    expect(validateFieldDefinitions(many).join(" ")).toMatch(/At most 20/);
  });

  test("validation happens when SAVING the tournament, not when registering", () => {
    // A broken form discovered by the first registrant has already lost
    // people. That is why `validateFieldDefinitions` exists separately.
    expect(validateFieldDefinitions([field({ label: "" })]).join(" ")).toMatch(/has no label/);
  });
});

// ── Answers ──────────────────────────────────────────────────────────────────

describe("validating answers", () => {
  test("normal text goes in clean", () => {
    const result = validateAnswers([field({})], { riot_id: "  Ahri#EUW  " });
    expect(result.ok).toBe(true);
    expect(result.clean.riot_id).toBe("Ahri#EUW");
  });

  test("what is required and missing is said WITH ITS LABEL", () => {
    // "riot_id is required" is not understood by whoever fills in the form.
    const result = validateAnswers([field({ required: true })], {});
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toContain("Riot ID");
  });

  test("an empty optional is OMITTED, not saved as null", () => {
    // That way `customData` only contains what the person really answered.
    const result = validateAnswers([field({})], { riot_id: "" });
    expect(result.ok).toBe(true);
    expect(result.clean).toEqual({});
  });

  test("returns ALL the problems, not the first", () => {
    // Whoever fills in a form should not discover the errors one at a time.
    const fields = [
      field({ key: "a", label: "A", required: true }),
      field({ key: "b", label: "B", required: true }),
    ];
    expect(validateAnswers(fields, {}).issues).toHaveLength(2);
  });

  test("a DROPDOWN only accepts its options", () => {
    // Deny-by-default: accepting any text would turn it into a free field
    // as soon as someone made the request by hand.
    const fields = [
      field({ key: "region", label: "Región", type: "select", options: ["EU", "NA"] }),
    ];
    expect(validateAnswers(fields, { region: "EU" }).ok).toBe(true);

    const bad = validateAnswers(fields, { region: "LATAM" });
    expect(bad.ok).toBe(false);
    expect(bad.issues.join(" ")).toMatch(/is not one of the options/);
  });

  test("a `javascript:` URL is REJECTED", () => {
    // This is rendered as a link in the TO's panel: a `javascript:` there is
    // XSS served on a platter.
    const fields = [field({ key: "vod", label: "VOD", type: "url" })];
    for (const bad of ["javascript:alert(1)", "data:text/html,<script>", "no es una url"]) {
      expect(validateAnswers(fields, { vod: bad }).ok, bad).toBe(false);
    }
    expect(validateAnswers(fields, { vod: "https://twitch.tv/x" }).ok).toBe(true);
  });

  test("numbers respect minimum and maximum", () => {
    const fields = [field({ key: "mmr", label: "MMR", type: "number", min: 0, max: 5000 })];
    expect(validateAnswers(fields, { mmr: "2500" }).clean.mmr).toBe(2500);
    expect(validateAnswers(fields, { mmr: 9000 }).ok).toBe(false);
    expect(validateAnswers(fields, { mmr: "no" }).ok).toBe(false);
  });

  test("a text that is too long is cut with a message, not silently", () => {
    const fields = [field({ maxLength: 10 })];
    expect(validateAnswers(fields, { riot_id: "x".repeat(20) }).issues.join(" ")).toMatch(/10/);
  });

  test("what arrives WITHOUT being defined is discarded", () => {
    // Storing it would let anyone fatten the row by sending made-up
    // fields that nobody will ever see.
    const result = validateAnswers([field({})], { riot_id: "Ahri", intruder: "lo que sea" });
    expect(result.clean).toEqual({ riot_id: "Ahri" });
  });
});

// ── Visibility ───────────────────────────────────────────────────────────────

describe("what appears in the public list", () => {
  const fields = [
    field({ key: "riot_id", label: "Riot ID", visibility: "public" }),
    field({ key: "paypal", label: "PayPal", type: "email", visibility: "organizer" }),
    field({ key: "phone", label: "Teléfono" }),
  ];
  const answers = { riot_id: "Ahri#EUW", paypal: "ana@x.com", phone: "600000000" };

  test("`organizer` fields do NOT appear", () => {
    expect(publicAnswers(fields, answers)).toEqual({ riot_id: "Ahri#EUW" });
  });

  test("WITHOUT declaring visibility, a field is PRIVATE", () => {
    // It is the decision that matters: if someone defines a field and forgets to
    // declare it, the safe thing is for it not to be published. The other way round, the oversight
    // would publish phone numbers.
    expect(publicAnswers(fields, answers)).not.toHaveProperty("phone");
  });

  test("an answer to a field that no longer exists does not appear either", () => {
    // Removing a field from the definition must stop publishing it, even if
    // the answer is still stored in old rows.
    expect(publicAnswers([], answers)).toEqual({});
  });
});
