/**
 * The adapter of each channel kind.
 */

import type { ChannelKind } from "../koe.schema";

import { instagram } from "./instagram";
import { messenger } from "./messenger";
import type { ChannelAdapter } from "./types";
import { webchat } from "./webchat";
import { whatsapp } from "./whatsapp";

export const adapters: Record<ChannelKind, ChannelAdapter> = { whatsapp, messenger, instagram, webchat };

export function adapterOf(kind: ChannelKind): ChannelAdapter {
  return adapters[kind];
}

export * from "./types";
