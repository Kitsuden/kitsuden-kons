/**
 * Kitsuden Newsletter — Mailables
 * ============================================================================
 * The kon's transactional emails: confirmation and welcome. They are
 * registered in the shared Mailer (`mail.register`) during `onStartup`, so
 * the host does not need to know anything about them.
 *
 * The campaign is NOT a Mailable: its content is dynamic and comes from the
 * database, not from a template. See `renderCampaignMessage` in the service.
 */

import { button, heading, layout, panel, paragraph, type Mailable } from "@kitsuden/engine";

import { unsubscribeHeaders } from "./newsletter.types";

// Re-exported so that whoever already imported it from here keeps working; the
// definition lives in newsletter.types because it is a pure function with no
// dependency on the mail engine.
export { unsubscribeHeaders };

export interface ConfirmData {
  to: string;
  name?: string;
  /** Absolute URL with the confirmation token. */
  confirmUrl: string;
  newsletterName: string;
  locale?: string;
}

export interface WelcomeData {
  to: string;
  name?: string;
  newsletterName: string;
  /** Unsubscribe URL — mandatory even in the welcome email. */
  unsubscribeUrl: string;
  locale?: string;
}

/**
 * Double opt-in.
 *
 * The elegance Ghost popularized: this same mechanism serves as consent
 * confirmation AND passwordless login. A single link
 * solves both things.
 *
 * The email does NOT carry List-Unsubscribe: they are not subscribed yet, and offering an
 * unsubscribe from something that does not exist is confusing. If they never confirm, the row expires.
 */
export const confirmSubscription: Mailable<ConfirmData> = {
  name: "newsletter.confirm",

  envelope: (data, ctx) => ({
    to: data.to,
    subject: ctx.t("newsletter.confirm.subject", { newsletter: data.newsletterName }),
    tag: "newsletter-confirm",
  }),

  content: (data, ctx) => ({
    html: layout({
      preheader: ctx.t("newsletter.confirm.heading"),
      body:
        heading(ctx.t("newsletter.confirm.heading")) +
        paragraph(
          ctx.t("newsletter.confirm.body", {
            newsletter: data.newsletterName,
            name: data.name ?? "",
          })
        ) +
        button(ctx.t("newsletter.confirm.cta"), data.confirmUrl) +
        panel(ctx.t("newsletter.confirm.ignore")),
    }),
  }),
};

/** Welcome after confirming. It already carries an unsubscribe, because they are already subscribed. */
export const welcomeSubscriber: Mailable<WelcomeData> = {
  name: "newsletter.welcome",

  envelope: (data, ctx) => ({
    to: data.to,
    subject: ctx.t("newsletter.welcome.subject", { newsletter: data.newsletterName }),
    tag: "newsletter-welcome",
    headers: unsubscribeHeaders(data.unsubscribeUrl),
  }),

  content: (data, ctx) => ({
    html: layout({
      preheader: ctx.t("newsletter.welcome.body"),
      body:
        heading(ctx.t("newsletter.welcome.heading", { newsletter: data.newsletterName })) +
        paragraph(ctx.t("newsletter.welcome.body")),
      footer: `<a href="${data.unsubscribeUrl}">${ctx.t("newsletter.unsubscribe")}</a>`,
    }),
  }),
};

/** All the kon's Mailables, for `mail.registerAll`. */
export const newsletterMailables = [confirmSubscription, welcomeSubscriber];

/**
 * Default translations, keyed by member locale (English first; Spanish too). A kon
 * contributes its own with `mail.addTranslations`, and the app can override or add
 * languages the same way.
 */
export const newsletterTranslations: Record<string, Record<string, string>> = {
  en: {
    "newsletter.confirm.subject": "Confirm your subscription to {newsletter}",
    "newsletter.confirm.heading": "One more step",
    "newsletter.confirm.body":
      "Click the button to confirm you want to receive {newsletter}. We won't send anything until you do.",
    "newsletter.confirm.cta": "Confirm subscription",
    "newsletter.confirm.ignore": "If this wasn't you, ignore this email — nothing will be sent.",
    "newsletter.welcome.subject": "Welcome to {newsletter}",
    "newsletter.welcome.heading": "You're in: {newsletter}",
    "newsletter.welcome.body": "Thanks for confirming. The next issue will land here.",
    "newsletter.unsubscribe": "Unsubscribe",
  },
  // Spanish, for members whose locale is `es` (the sign-up's `locale`).
  es: {
    "newsletter.confirm.subject": "Confirma tu suscripción a {newsletter}",
    "newsletter.confirm.heading": "Un paso más",
    "newsletter.confirm.body":
      "Pulsa el botón para confirmar que quieres recibir {newsletter}. Sin este paso no te enviaremos nada.",
    "newsletter.confirm.cta": "Confirmar suscripción",
    "newsletter.confirm.ignore": "Si no fuiste tú, ignora este correo: sin confirmación no se envía nada.",
    "newsletter.welcome.subject": "Bienvenido a {newsletter}",
    "newsletter.welcome.heading": "Ya estás en {newsletter}",
    "newsletter.welcome.body": "Gracias por confirmar. El próximo número llegará aquí.",
    "newsletter.unsubscribe": "Darse de baja",
  },
};
