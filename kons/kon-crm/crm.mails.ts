/**
 * CRM — The kon's emails (proof that a plugin contributes its own)
 * ============================================================================
 *
 * Demonstrates the requirement: a kon defines and registers ITS emails without touching the
 * host. It imports from `@kitsuden/engine` (framework layer), not from `apps/api`.
 *
 * They are registered in the kon's `onStartup` hook — see index.ts.
 */

import {
  button,
  heading,
  layout,
  mailTable,
  paragraph,
  type Mailable,
  type Mailer,
} from "@kitsuden/engine";

// ── Deal won ─────────────────────────────────────────────────────────────────

export interface DealWonData {
  to: string;
  dealName: string;
  amount: string;
  companyName: string;
  dealUrl?: string;
}

export const dealWonMail: Mailable<DealWonData> = {
  name: "crm.deal-won",

  envelope: (data, ctx) => ({
    to: data.to,
    subject: ctx.t("crm.deal_won.subject", { deal: data.dealName }),
    tag: "crm",
  }),

  content: (data, ctx) => ({
    html: layout({
      appName: ctx.appName,
      preheader: ctx.t("crm.deal_won.preheader", { amount: data.amount }),
      body:
        heading(ctx.t("crm.deal_won.heading")) +
        paragraph(ctx.t("crm.deal_won.intro", { deal: data.dealName })) +
        mailTable([
          [ctx.t("crm.field.company"), data.companyName],
          [ctx.t("crm.field.amount"), data.amount],
        ]) +
        (data.dealUrl ? button(ctx.t("crm.deal_won.cta"), data.dealUrl) : ""),
    }),
  }),
};

// ── Kon translations ───────────────────────────────────────────────────────

const EN = {
  "crm.deal_won.subject": "Deal won: {deal}",
  "crm.deal_won.preheader": "Worth {amount}.",
  "crm.deal_won.heading": "Deal won 🎉",
  "crm.deal_won.intro": 'The deal "{deal}" just moved to Won.',
  "crm.deal_won.cta": "View deal",
  "crm.field.company": "Company",
  "crm.field.amount": "Amount",
};

const ES = {
  "crm.deal_won.subject": "Deal won: {deal}",
  "crm.deal_won.preheader": "For {amount}.",
  "crm.deal_won.heading": "Deal won 🎉",
  "crm.deal_won.intro": 'The deal "{deal}" moved to Won.',
  "crm.deal_won.cta": "View the deal",
  "crm.field.company": "Empresa",
  "crm.field.amount": "Importe",
};

/** Call from the kon's `onStartup` hook. */
export function registerCrmMails(mailer: Mailer): void {
  mailer.register(dealWonMail).addTranslations("en", EN).addTranslations("es", ES);
}
