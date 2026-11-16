/**
 * The host's `ctx.secrets`, as a test double
 * ============================================================================
 *
 * Same contract as Kitsuden's `KonSecrets`: `seal` is AES-256-GCM with the kon id as associated data (a
 * value sealed for one kon does not open for another), `open` records who opened what and why. The key is
 * random per process: nothing sealed in a test is readable outside it.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface SealedValue {
  v: 1;
  kon: string;
  valueEncrypted: string;
  iv: string;
  authTag: string;
}

export function fakeSecrets() {
  const key = randomBytes(32);
  const opened: Array<{ kon: string; purpose: string; subject?: string }> = [];
  return {
    opened,
    seal(kon: string, plaintext: string): SealedValue {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(kon));
      const valueEncrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]).toString("base64");
      return { v: 1, kon, valueEncrypted, iv: iv.toString("base64"), authTag: cipher.getAuthTag().toString("base64") };
    },
    async open(kon: string, sealed: SealedValue, access: { purpose: string; subject?: string }): Promise<string> {
      if (sealed.kon !== kon) throw new Error("sealed for another kon");
      opened.push({ kon, purpose: access.purpose, subject: access.subject });
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(sealed.iv, "base64"));
      decipher.setAAD(Buffer.from(kon));
      decipher.setAuthTag(Buffer.from(sealed.authTag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(sealed.valueEncrypted, "base64")), decipher.final()]).toString("utf8");
    },
  };
}
