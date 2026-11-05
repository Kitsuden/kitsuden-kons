/**
 * Kon Members — magic link email
 * ============================================================================
 * `POST /signin` issues the token through the `members.signin-requested` event,
 * but nobody was listening to it: neither the core nor another kon. In a normal
 * installation the reader requested the link and the email never went out, so
 * there was no way to sign in (an earlier audit). Now the kon sends it itself through
 * the shared Mailer, like kon-newsletter with its double opt-in. The event is
 * kept for whoever wants another delivery (SMS, a webhook…);
 * `MEMBERS_SIGNIN_MAIL=off` turns off the email if that delivery replaces it.
 *
 * The link points to the SITE page that completes the sign-in
 * (`MEMBERS_SIGNIN_URL`, by default `<siteUrl>/members/verify`): that page
 * does `POST /api/members/signin/verify` with the token. It does not point at
 * the API with a GET because a GET that opens a session is triggered by any
 * link previewer in the mail client and burns the single-use token.
 */

import { button, heading, layout, mail, panel, paragraph, type Mailable } from "@kitsuden/engine";

export interface SigninData {
  to: string;
  name?: string;
  /** Absolute URL of the site page, with the token. */
  signinUrl: string;
}

export const memberSignin: Mailable<SigninData> = {
  name: "members.signin",

  envelope: (data, ctx) => ({
    to: data.to,
    subject: ctx.t("members.signin.subject"),
    tag: "members-signin",
  }),

  content: (data, ctx) => ({
    html: layout({
      preheader: ctx.t("members.signin.heading"),
      body:
        heading(ctx.t("members.signin.heading")) +
        paragraph(ctx.t("members.signin.body", { name: data.name ?? "" })) +
        button(ctx.t("members.signin.cta"), data.signinUrl) +
        panel(ctx.t("members.signin.ignore")),
    }),
  }),
};

export const membersTranslations: Record<string, Record<string, string>> = {
  es: {
    "members.signin.subject": "Your sign-in link",
    "members.signin.heading": "Sign in with one click",
    "members.signin.body": "Press the button to sign in. The link expires in a few minutes and works only once.",
    "members.signin.cta": "Entrar",
    "members.signin.ignore": "If you did not request it, ignore this email.",
  },
  en: {
    "members.signin.subject": "Your sign-in link",
    "members.signin.heading": "Sign in with one click",
    "members.signin.body": "Click the button to sign in. The link expires in a few minutes and works once.",
    "members.signin.cta": "Sign in",
    "members.signin.ignore": "If you didn't ask for this, ignore this email.",
  },
};

/** Registers the email and its texts only once (the router and `onStartup` call it). */
export function registerMembersMails(): void {
  if (!mail.has(memberSignin.name)) mail.register(memberSignin);
  for (const [locale, entries] of Object.entries(membersTranslations)) {
    mail.addTranslations(locale, entries);
  }
}

/** The link URL: the site page that completes the sign-in, with the token. */
export function accessUrl(siteUrl: string, token: string, env = process.env): string {
  const base = env.MEMBERS_SIGNIN_URL || `${(siteUrl || "").replace(/\/$/, "")}/members/verify`;
  const url = new URL(base);
  url.searchParams.set("token", token);
  return url.toString();
}

export const accessMailActive = (env = process.env) =>
  (env.MEMBERS_SIGNIN_MAIL ?? "").toLowerCase() !== "off";
