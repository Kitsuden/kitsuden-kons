/**
 * kon-dc — the bot's own words in the member's language
 * ============================================================================
 *
 * The built-in modules write English and call `rt.t("You have {n} coins.", { n })`: the English
 * text IS the key, so anything not translated yet still reads well. The language is the member's
 * own Discord language in interactions, and the server's (its preferred locale) for what the bot
 * says by itself. Slash commands get Discord's `name_localizations`/`description_localizations`
 * from the same dictionary, so `/daily` shows its Spanish description to a Spanish client.
 *
 * Blueprints and module settings are written by the server's staff in their own language: they are
 * never translated.
 *
 * To add a language: a dictionary below, `LANGS`, and `langOf`. A test fails when a key has no
 * `{placeholder}` the English has, or the other way round.
 */

import { TEXTS } from "./dc.i18n.texts";

export const LANGS = ["en", "es", "pt"] as const;
export type Lang = (typeof LANGS)[number];

/** Discord's locales (es-ES, es-419, pt-BR, en-US…) to ours. */
export function langOf(locale: string | null | undefined): Lang {
  const l = (locale ?? "").toLowerCase();
  if (l.startsWith("es")) return "es";
  if (l.startsWith("pt")) return "pt";
  return "en";
}

/** Discord locales each language is announced under, for command localizations. */
export const DISCORD_LOCALES: Record<Exclude<Lang, "en">, string[]> = {
  es: ["es-ES", "es-419"],
  pt: ["pt-BR"],
};

export type Vars = Record<string, string | number | null | undefined>;

const fill = (text: string, vars?: Vars) =>
  vars ? text.replace(/\{([a-zA-Z0-9_]+)\}/g, (m, k: string) => (Object.hasOwn(vars, k) && vars[k] != null ? String(vars[k]) : m)) : text;

/** The text in a language (English when there is no translation), with `{name}` filled in. */
export function translate(lang: Lang, text: string, vars?: Vars): string {
  const dict = lang === "en" ? undefined : DICTIONARIES[lang];
  const found = dict && Object.hasOwn(dict, text) ? dict[text] : undefined;
  return fill(found ?? text, vars);
}

/** `{ "es-ES": "…", "es-419": "…", "pt-BR": "…" }` for a text that has translations. */
export function localizations(text: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const lang of ["es", "pt"] as const) {
    const t = DICTIONARIES[lang][text];
    if (t) for (const loc of DISCORD_LOCALES[lang]) out[loc] = t.slice(0, 100);
  }
  return Object.keys(out).length ? out : undefined;
}

interface Localizable {
  name: string;
  description: string;
  options?: Localizable[];
  description_localizations?: Record<string, string>;
}

/** A command payload with Discord's localized descriptions added (recursively, for options). */
export function localizeCommand<T extends Localizable>(c: T): T {
  const description_localizations = c.description ? localizations(c.description) : undefined;
  return {
    ...c,
    ...(description_localizations ? { description_localizations } : {}),
    ...(c.options ? { options: c.options.map((o) => localizeCommand(o)) } : {}),
  };
}

// ── Dictionaries ────────────────────────────────────────────────────────────────────────────────

type Dict = Record<string, string>;

const es: Dict = {};
const pt: Dict = {};

export const DICTIONARIES: Record<Exclude<Lang, "en">, Dict> = { es, pt };

for (const [en, esText, ptText] of TEXTS) {
  es[en] = esText;
  pt[en] = ptText;
}

/** Adds translations: `[english, spanish, portuguese]`. */
export function addTranslations(rows: Array<[string, string, string]>) {
  for (const [en, esText, ptText] of rows) {
    es[en] = esText;
    pt[en] = ptText;
  }
}
