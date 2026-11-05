/**
 * Importing contacts from a spreadsheet, looking before writing
 * ============================================================================
 *
 * A wrong import is the usual way a CRM fills with duplicates, and undoing one is manual. So the same
 * operation has two steps: `apply: false` says what each row would do, `apply: true` does it.
 *
 * Duplicates are by email, in the file and against the base. An existing contact gains only what it lacked,
 * and addresses on the exclusion list are never brought in.
 */

import { AppError } from "@kitsuden/engine";
import { sql } from "drizzle-orm";
import { z } from "zod";

import { dbDe, userOf } from "./crm.context";
import type { CrmDb } from "./crm.db";
import { normalizeEmail } from "./crm.dedupe";
import { isSuppressed } from "./crm.intake";
import { crmContacts } from "./crm.schema";
import { EDIT, type registry } from "./operations";

/** RFC 4180: quoted fields, doubled quotes, newlines inside quotes. Also `;` and tabs, which spreadsheets export. */
export function parseCsv(text: string): string[][] {
  const source = text.replace(/^﻿/, "");
  const firstLine = source.split(/\r?\n/, 1)[0] ?? "";
  const separator = [",", ";", "\t"].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0]!;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (quoted) {
      if (ch === '"' && source[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === separator) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && source[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((v) => v.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((v) => v.trim() !== "")) rows.push(row);
  return rows;
}

/**
 * Column headers recognized without a mapping, by the language the spreadsheet was exported in.
 * The English ones are the canonical names; the others are a convenience for files that come
 * from a tool set up in that language (like a translation table, not part of the API). Headers
 * are compared without case or accents. Add a language here, never a field.
 */
const HEADERS_BY_LANGUAGE: Record<string, Record<string, string>> = {
  en: {
    email: "email",
    mail: "email",
    firstname: "firstName",
    first_name: "firstName",
    lastname: "lastName",
    last_name: "lastName",
    phone: "phone",
    mobile: "mobile",
    jobtitle: "jobTitle",
    job_title: "jobTitle",
    department: "department",
    city: "city",
    country: "country",
    source: "source",
  },
  es: {
    correo: "email",
    nombre: "firstName",
    apellido: "lastName",
    telefono: "phone",
    movil: "mobile",
    cargo: "jobTitle",
    departamento: "department",
    ciudad: "city",
    pais: "country",
    origen: "source",
  },
};
const ALIASES: Record<string, string> = Object.assign({}, ...Object.values(HEADERS_BY_LANGUAGE));
const FIELDS = new Set(Object.values(ALIASES));
const plain = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

/** Which contact field each column fills. `custom.x` keeps its own name; an unknown column is reported and left out. */
export function mapColumns(header: string[], mapping: Record<string, string> = {}) {
  const ignored: string[] = [];
  const fields = header.map((raw) => {
    const name = raw.trim();
    const chosen = mapping[name] ?? ALIASES[plain(name)];
    if (chosen && (FIELDS.has(chosen) || chosen.startsWith("custom."))) return chosen;
    if (name.startsWith("custom.")) return name;
    ignored.push(name);
    return null;
  });
  return { fields, ignored };
}

const MAX_ROWS = 5000;
const Input = z.object({
  csv: z.string().min(1).max(5_000_000).describe("The file's text, with a header row"),
  mapping: z.record(z.string(), z.string()).optional().describe("Column → field, when the header is not recognized"),
  apply: z.boolean().optional().describe("`false` or absent: only say what would happen"),
});

type Status = "new" | "existing" | "repeated" | "suppressed" | "invalid";
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function existingEmails(db: CrmDb, emails: string[]): Promise<Map<string, typeof crmContacts.$inferSelect>> {
  const found = new Map<string, typeof crmContacts.$inferSelect>();
  for (let i = 0; i < emails.length; i += 500) {
    const part = emails.slice(i, i + 500);
    const rows = await db
      .select()
      .from(crmContacts)
      .where(sql`lower(${crmContacts.email}) IN (${sql.join(part.map((e) => sql`${e}`), sql`, `)})`);
    for (const row of rows) found.set(row.email.toLowerCase(), row);
  }
  return found;
}

export function importOperations(routes: ReturnType<typeof registry>): void {
  routes.post(
    "/contacts/import",
    {
      id: "import-contacts",
      summary: "Import contacts from a CSV",
      description:
        "Without `apply` it writes nothing and returns, for each row, `new`, `existing` (only its gaps would be filled), `repeated` in the file, `suppressed` or `invalid`, plus the columns it ignored. With `apply: true` it does that. At most 5000 rows. Requires CRM edit access.",
      access: "session",
      permission: EDIT,
      input: { body: Input },
      output: { schema: z.object({}).passthrough() },
    },
    async (c, input) => {
      const db = dbDe(c);
      const rows = parseCsv(input.body.csv);
      if (rows.length < 2) throw AppError.validation("The file needs a header row and at least one contact");
      if (rows.length - 1 > MAX_ROWS) throw AppError.validation(`At most ${MAX_ROWS} rows at a time`);
      const { fields, ignored } = mapColumns(rows[0]!, input.body.mapping);
      if (!fields.includes("email")) throw AppError.validation("No column is the email: use `mapping`");

      const parsed = rows.slice(1).map((cells, index) => {
        const contact: Record<string, unknown> = {};
        const custom: Record<string, string> = {};
        fields.forEach((f, i) => {
          const value = (cells[i] ?? "").trim();
          if (!f || !value) return;
          if (f.startsWith("custom.")) custom[f.slice("custom.".length)] = value;
          else contact[f] = value;
        });
        const email = normalizeEmail(contact.email as string | undefined);
        return { row: index + 2, email, contact, custom };
      });

      const known = await existingEmails(db, [...new Set(parsed.map((p) => p.email).filter(Boolean))]);
      const seen = new Set<string>();
      const plan: { row: number; email: string; status: Status; contact: Record<string, unknown>; custom: Record<string, string> }[] = [];
      for (const p of parsed) {
        let status: Status;
        if (!EMAIL.test(p.email)) status = "invalid";
        else if (seen.has(p.email)) status = "repeated";
        else if (await isSuppressed(db, p.email)) status = "suppressed";
        else status = known.has(p.email) ? "existing" : "new";
        seen.add(p.email);
        plan.push({ ...p, status });
      }
      const summary = { new: 0, existing: 0, repeated: 0, suppressed: 0, invalid: 0 };
      for (const p of plan) summary[p.status]++;

      if (input.body.apply) {
        const createdBy = userOf(c)?.id ?? null;
        for (const p of plan) {
          if (p.status === "new") {
            await db.insert(crmContacts).values({
              firstName: "",
              lastName: "",
              ...(p.contact as object),
              email: p.email,
              customFields: p.custom,
              source: (p.contact.source as string) ?? "import",
              origin: "import",
              createdBy,
            } as typeof crmContacts.$inferInsert);
          } else if (p.status === "existing") {
            const current = known.get(p.email)! as unknown as Record<string, unknown>;
            const gaps: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(p.contact)) {
              if (k !== "email" && (current[k] === null || current[k] === undefined || current[k] === "")) gaps[k] = v;
            }
            if (Object.keys(gaps).length > 0) {
              await db
                .update(crmContacts)
                .set({ ...gaps, updatedAt: new Date() } as Partial<typeof crmContacts.$inferInsert>)
                .where(sql`${crmContacts.id} = ${current.id}`);
            }
          }
        }
      }
      return c.json({
        applied: !!input.body.apply,
        summary,
        ignoredColumns: ignored,
        rows: plan.map(({ row, email, status }) => ({ row, email, status })),
      });
    }
  );
}
