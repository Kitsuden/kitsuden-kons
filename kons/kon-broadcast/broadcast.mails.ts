/**
 * Broadcast — Kon emails
 * ============================================================================
 *
 * A kon defines and registers ITS OWN emails. It imports from `@kitsuden/engine`
 * (framework layer), never from `apps/api`.
 *
 * They are registered in the `onStartup` hook (see index.ts), so the app has them
 * available without the host knowing anything about this kon.
 *
 *   await ctx.queue.add("broadcast.match-scheduled", { to, eventTitle, round, overlayUrl });
 *
 * The job name IS the Mailable's name: queueing a new email does not
 * require touching the worker.
 */

import { button, heading, layout, paragraph, type Mailable, type Mailer } from "@kitsuden/engine";

/** Notice to the production team that a set is ready to go on air. */
export interface BroadcastMatchScheduledData {
  to: string;
  eventTitle: string;
  round: string;
  /** Overlay URL to paste into the OBS Browser Source. */
  overlayUrl?: string;
}

export const broadcastMatchScheduledMail: Mailable<BroadcastMatchScheduledData> = {
  name: "broadcast.match-scheduled",

  envelope: (data, ctx) => ({
    to: data.to,
    subject: ctx.t("broadcast.match-scheduled.subject", { round: data.round }),
    tag: "broadcast",
  }),

  content: (data, ctx) => ({
    // The engine's shared layout: no duplicated HTML of our own.
    html: layout({
      appName: ctx.appName,
      body:
        heading(ctx.t("broadcast.match-scheduled.heading", { event: data.eventTitle })) +
        paragraph(ctx.t("broadcast.match-scheduled.intro", { round: data.round })) +
        (data.overlayUrl ? button(ctx.t("broadcast.match-scheduled.cta"), data.overlayUrl) : ""),
    }),
  }),
};

const EN = {
  "broadcast.match-scheduled.subject": "Set ready to go live: {round}",
  "broadcast.match-scheduled.heading": "{event} — set ready",
  "broadcast.match-scheduled.intro": "The {round} set is loaded and ready for the stream.",
  "broadcast.match-scheduled.cta": "Open the overlay",
};

const ES = {
  "broadcast.match-scheduled.subject": "Set ready for live: {round}",
  "broadcast.match-scheduled.heading": "{event} — set ready",
  "broadcast.match-scheduled.intro": "The {round} set is loaded and ready for the live broadcast.",
  "broadcast.match-scheduled.cta": "Open the overlay",
};

/** Call from the kon's `onStartup` hook. */
export function registerBroadcastMails(mailer: Mailer): void {
  mailer.register(broadcastMatchScheduledMail).addTranslations("en", EN).addTranslations("es", ES);
}
