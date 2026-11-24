/**
 * Kons store files through ctx.storage, never with a raw S3 client
 * ============================================================================
 *
 * The core picks the bucket for every key (`bucketFor` in `apps/api/src/lib/storage.ts`): with
 * `S3_PRIVATE_BUCKET` set, `private/…` keys (a customer's voice note, a contract, an invoice) live in a
 * bucket with no public access, and everything else in the public one. That choice only holds if it is
 * the ONE way in. A kon that builds its own S3 client, or takes the core's raw client and bucket name,
 * can write a `private/` key to the public bucket, where anyone with the address reads it.
 *
 * The core closed its side in Kitsuden/kitsuden#54 (`s3`, `BUCKET`, `PUBLIC_URL` and `getS3Client` are no
 * longer exported; `tests/unit/storage-single-seam.test.ts` there). This guard closes the kons' side,
 * where most of them are written. A kon stores files with `ctx.storage` (`save`, `read`, `delete`,
 * `publicUrl`, `getSignedDownloadUrl`), or with the engine's `uploadFile`, `uploadBuffer`, `deleteFile`,
 * `fileExists`, `getFile` and `generateSignedDownloadUrl`, which all pick the bucket. So no kon may:
 *
 *   · import the AWS SDK (`@aws-sdk/*`), or list it in its package.json;
 *   · import the core's storage modules directly (`@api/lib/storage`, `@api/lib/store`, a relative path
 *     into `apps/api/src/lib/storage|store`, `services/storage`);
 *   · import `s3`, `BUCKET`, `PUBLIC_URL` or `getS3Client` from `@kitsuden/engine` (an older core still
 *     exports them).
 */

import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { listFiles } from "../../.kitsuden/tests/unit/helpers/files";

const ROOT = join(__dirname, "..", "..");
const KONS = join(ROOT, "kons");

/** A module specifier in `from "x"`, `import("x")`, `require("x")` or a bare `import "x"`. */
const SPECIFIER =
  /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;

/** The core's storage modules, by alias or by a relative path into the core. */
const CORE_STORAGE =
  /^(?:@api|@)\/(?:lib\/(?:storage|store)|services\/storage)(?:\.[jt]s)?$|apps\/api\/src\/(?:lib\/(?:storage|store)|services\/storage)(?:\.[jt]s)?$/;

const RAW_ENGINE_EXPORTS = new Set(["s3", "BUCKET", "PUBLIC_URL", "getS3Client"]);

function sources(): string[] {
  return listFiles(KONS, ".ts", ".tsx", ".mts", ".js", ".mjs", ".svelte").filter((file) => {
    const parts = relative(KONS, file).split(sep);
    // Built output and installed dependencies are not written by hand.
    return !parts.includes("node_modules") && !parts.includes("dist") && parts[1] !== "admin";
  });
}

/** `file:line` of the first line at or after `index` in `text`. */
function where(file: string, text: string, index: number): string {
  return `${relative(ROOT, file)}:${text.slice(0, index).split("\n").length}`;
}

describe("kons store files only through ctx.storage", () => {
  const files = sources();

  it("finds kon sources to check", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("no kon imports the AWS SDK or the core's storage modules", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf-8");
      for (const m of text.matchAll(SPECIFIER)) {
        const spec = m[1]!;
        if (spec.startsWith("@aws-sdk/") || CORE_STORAGE.test(spec)) {
          offenders.push(`${where(file, text, m.index!)} → ${spec}`);
        }
      }
    }
    expect(
      offenders,
      "use ctx.storage: the core picks the bucket, and a private/ key must never reach the public one"
    ).toEqual([]);
  });

  it("no kon imports the raw client or the bucket name from @kitsuden/engine", () => {
    const IMPORT_FROM_ENGINE =
      /import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']@kitsuden\/engine["']/g;
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf-8");
      for (const m of text.matchAll(IMPORT_FROM_ENGINE)) {
        const names = m[1]!
          .split(",")
          .map((part) =>
            part
              .trim()
              .replace(/^type\s+/, "")
              .split(/\s+as\s+/)[0]!
              .trim()
          )
          .filter((name) => RAW_ENGINE_EXPORTS.has(name));
        for (const name of names) offenders.push(`${where(file, text, m.index!)} → ${name}`);
      }
    }
    expect(offenders, "use ctx.storage or the engine's uploadFile/deleteFile/…").toEqual([]);
  });

  it("no kon depends on the AWS SDK", () => {
    const offenders = listFiles(KONS, ".json")
      .filter((file) => file.endsWith(`${sep}package.json`))
      .filter((file) => !relative(KONS, file).split(sep).includes("node_modules"))
      .flatMap((file) => {
        const pkg = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
        return ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"]
          .flatMap((field) => Object.keys((pkg[field] as Record<string, string>) ?? {}))
          .filter((name) => name.startsWith("@aws-sdk/"))
          .map((name) => `${relative(ROOT, file)} → ${name}`);
      });
    expect(offenders).toEqual([]);
  });

  it("the patterns catch what they are meant to (and not ctx.storage)", () => {
    const specs = (text: string) => [...text.matchAll(SPECIFIER)].map((m) => m[1]);
    expect(specs(`import { S3Client } from "@aws-sdk/client-s3";`)).toEqual(["@aws-sdk/client-s3"]);
    expect(specs(`const s = await import('@aws-sdk/client-s3')`)).toEqual(["@aws-sdk/client-s3"]);
    for (const spec of [
      "@api/lib/storage",
      "@api/lib/store",
      "@/lib/storage",
      "@api/services/storage",
      "../../../.kitsuden/apps/api/src/lib/storage",
      "../../apps/api/src/lib/store.ts",
    ]) {
      expect(CORE_STORAGE.test(spec), spec).toBe(true);
    }
    for (const spec of [
      "@api/lib/storage-quota",
      "@kitsuden/engine",
      "./storage",
      "../lib/store",
    ]) {
      expect(CORE_STORAGE.test(spec), spec).toBe(false);
    }
  });
});
