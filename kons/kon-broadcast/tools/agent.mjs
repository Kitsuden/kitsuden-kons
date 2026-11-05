#!/usr/bin/env node
/**
 * Local MOBA ingest agent
 * ============================================================================
 *
 * Reads the Live Client Data API of the League client running on THIS PC and
 * pushes every frame to Kitsuden. It is the piece that makes it possible for someone to
 * spectate on their computer while the overlay comes out of a server that is
 * somewhere else.
 *
 * Usage:
 *
 *   node agent.mjs --url https://my-server.com --game <gameId> --token <token>
 *
 * The token is given by `POST /api/broadcast/games/:id/ingest/push-token`, is
 * tied to that game and can be revoked. **It is not the user's session**: if it
 * leaks, all it allows is writing frames to one specific game.
 *
 * ── Why the browser does not do it ──────────────────────────────────────────
 * The certificate of `127.0.0.1:2999` is self-signed, the page goes over HTTPS
 * (mixed content) and the local API sends no CORS. Each of the three on its own
 * is enough to prevent it. Node can.
 *
 * No dependencies: Node 18+ only.
 */

import { Agent } from "node:https";

// ── Arguments ────────────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .join(" ")
    .matchAll(/--([\w-]+)(?:[= ]([^\s-][^\s]*))?/g)
    .map((m) => [m[1], m[2] ?? true])
);

const SERVER = String(args.url ?? "http://localhost:3000").replace(/\/+$/, "");
const GAME = args.game;
const TOKEN = args.token;
const LOCAL = String(args.local ?? "https://127.0.0.1:2999").replace(/\/+$/, "");
const INTERVAL = Number(args.interval ?? 500);

if (!GAME || !TOKEN) {
  console.error(
    "Missing arguments.\n\n" +
      "  node agent.mjs --url https://my-server.com --game <gameId> --token <token>\n\n" +
      "Optional: --interval 500  --local https://127.0.0.1:2999"
  );
  process.exit(1);
}

/**
 * Riot's certificate is self-signed. It is accepted ONLY for this agent and
 * ONLY against the local host — `NODE_TLS_REJECT_UNAUTHORIZED` is never touched,
 * since that would turn off verification for the whole process, including the upload to the
 * server.
 */
const localAgent = new Agent({ rejectUnauthorized: false });

// ── Loop ─────────────────────────────────────────────────────────────────────

let lastSeen = null;
let missing = 0;

async function readLocal() {
  try {
    const res = await fetch(`${LOCAL}/liveclientdata/allgamedata`, {
      dispatcher: undefined,
      agent: localAgent,
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    // During loading the API responds with an almost empty object.
    return data?.allPlayers?.length ? data : null;
  } catch {
    // Client closed, game not started, timeout. All of this is normal.
    return null;
  }
}

async function push(payload) {
  try {
    const res = await fetch(`${SERVER}/api/broadcast/games/${GAME}/ingest/push`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-broadcast-ingest-token": String(TOKEN) },
      body: JSON.stringify({ raw: payload }),
      signal: AbortSignal.timeout(4000),
    });
    if (res.status === 401 || res.status === 403) {
      console.error("Token rejected. Request a new one and restart the agent.");
      process.exit(1);
    }
    return res.ok;
  } catch {
    // The user's network goes down; it is retried on the next frame. Retries are not
    // accumulated: an old frame is worth nothing live.
    return false;
  }
}

async function tick() {
  const data = await readLocal();

  if (data) {
    missing = 0;
    const clock = Math.round(data.gameData?.gameTime ?? 0);
    if (clock !== lastSeen) {
      lastSeen = clock;
      const ok = await push(data);
      process.stdout.write(`\r${ok ? "→" : "×"} ${fmt(clock)}   `);
    }
  } else if (lastSeen !== null && ++missing === 4) {
    // Four empty reads in a row: the game is over or the client
    // closed. It is warned about once, not on every loop.
    process.stdout.write("\n· no game\n");
    lastSeen = null;
  }

  // It is rescheduled AFTER finishing: if a read takes longer than the
  // interval, `setInterval` would queue requests until drowning the client.
  setTimeout(tick, INTERVAL);
}

function fmt(seconds) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

console.log(`MOBA agent · game ${GAME} · ${SERVER}`);
console.log(`Reading ${LOCAL} every ${INTERVAL}ms. Ctrl+C to stop.\n`);
tick();
