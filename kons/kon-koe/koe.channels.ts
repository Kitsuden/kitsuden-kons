/**
 * Channel credentials: sealed at rest, opened for one call
 * ============================================================================
 *
 * Access tokens and app secrets are sealed with the core's `ctx.secrets` (AES-GCM, bound to this kon,
 * every opening recorded) and kept in `koe_channels.access_token` / `app_secret`. A host without
 * `ctx.secrets` cannot store them: connecting a Meta channel answers 409 instead of keeping a readable
 * token. They are opened as late as possible and never returned by an operation.
 */

import { AppError, asSystem } from "@kitsuden/engine";
import type { KonContext, SealedSecret } from "@kitsuden/shared";
import { and, eq } from "drizzle-orm";

import { DEFAULT_GRAPH_VERSION } from "./channels/graph";
import type { ChannelAuth } from "./channels/types";
import { KON_ID, type Db } from "./koe.common";
import { koeChannels, type Channel, type ChannelKind } from "./koe.schema";

export function seal(ctx: KonContext, value: string): SealedSecret {
  if (!ctx.secrets) throw AppError.conflict("This installation cannot store credentials (no secrets key): set KITSUDEN_SECRETS_KEY");
  return ctx.secrets.seal(KON_ID, value);
}

async function open(ctx: KonContext, sealed: unknown, purpose: string, channelId: string): Promise<string> {
  if (!ctx.secrets) throw new Error("This installation cannot open credentials (no secrets key)");
  if (!sealed) throw new Error("The channel has no credential stored");
  return ctx.secrets.open(KON_ID, sealed as SealedSecret, { purpose, subject: `channel:${channelId}` });
}

/** What an adapter needs for one call. Web chat needs nothing. */
export async function authOf(ctx: KonContext, channel: Channel, purpose: string): Promise<ChannelAuth> {
  return {
    externalId: channel.externalId,
    accountId: channel.accountId,
    accessToken: channel.kind === "webchat" ? "" : await open(ctx, channel.accessToken, purpose, channel.id),
    graphVersion: channel.settings?.graphVersion ?? DEFAULT_GRAPH_VERSION,
  };
}

export async function appSecretOf(ctx: KonContext, channel: Channel): Promise<string | null> {
  if (!channel.appSecret) return null;
  return open(ctx, channel.appSecret, "verify-webhook", channel.id);
}

export async function channelBy(db: Db, kind: ChannelKind, externalId: string): Promise<Channel | undefined> {
  const [row] = (await asSystem(() =>
    db.select().from(koeChannels).where(and(eq(koeChannels.kind, kind), eq(koeChannels.externalId, externalId))).limit(1)
  )) as Channel[];
  return row;
}

export async function channelById(db: Db, id: string): Promise<Channel | undefined> {
  const [row] = (await asSystem(() => db.select().from(koeChannels).where(eq(koeChannels.id, id)).limit(1))) as Channel[];
  return row;
}

/** Without credentials, for anything that leaves the API. */
export function publicChannel(c: Channel) {
  const { accessToken, appSecret, ...rest } = c;
  return { ...rest, hasAccessToken: !!accessToken, hasAppSecret: !!appSecret };
}
