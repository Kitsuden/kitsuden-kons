/**
 * The event the blog emits on publish is the one the newsletter listens to
 * ============================================================================
 *
 * kon-blog emits `blog:post:published`; kon-newsletter listened to
 * `blog:published`, which nobody emits, and auto-send (NEWSLETTER_AUTO_SEND)
 * never fired. The two kons do not import each other: the contract is the
 * event name, and it is checked against the source code.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "../..");
const read = (route: string) => readFileSync(resolve(root, route), "utf8");

const emitted = (source: string) =>
  [...source.matchAll(/events\.emit\(\s*["']([^"']+)["']/g)].map((m) => m[1]);
const listened = (source: string) =>
  [...source.matchAll(/events\.on\??\.?\(\s*["']([^"']+)["']/g)].map((m) => m[1]);

describe("blog → newsletter", () => {
  it("the newsletter listens to a blog event that the blog really emits", () => {
    const ofBlog = new Set(emitted(read("kons/kon-blog/src/routes.ts")));
    const ofNewsletter = listened(read("kons/kon-newsletter/index.ts")).filter((e) =>
      e.startsWith("blog:")
    );
    expect(ofBlog.has("blog:post:published")).toBe(true);
    expect(ofNewsletter.length).toBeGreaterThan(0);
    for (const event of ofNewsletter) expect(ofBlog, event).toContain(event);
  });
});
