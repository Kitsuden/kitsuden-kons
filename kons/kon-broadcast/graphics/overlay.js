/**
 * Broadcast — broadcast graphic logic
 * ============================================================================
 *
 * Plain JS, no framework and no build. Loaded from the overlay's HTML.
 *
 * Three things a live overlay has to get right, and which are the reason
 * this is not a `fetch` in a `setInterval`:
 *
 *   1. **Discard late messages.** Each channel message carries a monotonic
 *      `revision`. After a reconnection they can arrive out of order, and
 *      applying an old one would make the scoreboard go BACKWARDS on screen.
 *   2. **Reconnect on its own, with backoff.** In a tournament the network goes down. The graphic
 *      cannot sit frozen waiting for someone to reload it in OBS.
 *   3. **Recover state after reconnecting.** On return it asks for the snapshot,
 *      because everything that happened while it was down was lost.
 *
 * It never writes user data with innerHTML: a gamertag with markup would
 * be an injection into the screen that goes on air.
 */

const params = new URLSearchParams(location.search);
const MATCH_ID = params.get("match");
const API = params.get("api") || "/api";

const $ = (sel) => document.querySelector(sel);
const layer = (name) => document.querySelector(`[data-layer="${name}"]`);
const conn = $("[data-conn]");

/** Last applied state. `revision` is the defense against reordering. */
let revision = -1;

// ── Render ───────────────────────────────────────────────────────────────────

/**
 * Character roster: slug → portrait.
 *
 * Fighting games do NOT have a public CDN equivalent to Data Dragon, so
 * the portraits are loaded by the deployment itself into `broadcast_champions` and
 * served by `kon-media`. It is read once at startup: a game's roster does not
 * change mid-tournament.
 */
const portraits = new Map();

async function loadRoster() {
  try {
    const res = await fetch(`${API}/broadcast/champions`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!res.ok) return; // without a roster the name is painted as text
    const { data } = await res.json();
    for (const champ of data ?? []) {
      if (champ.slug && champ.portraitUrl) portraits.set(champ.slug, champ.portraitUrl);
    }
  } catch {
    // Without a roster the overlay keeps painting the character's name. It is a
    // visual improvement, not a requirement for broadcasting.
  }
}

/**
 * Character chips: portrait if there is one, text if not.
 *
 * The text fallback is not a courtesy: in a tournament with a character just
 * released, the portrait takes days to upload and the set has to be broadcast anyway.
 */
function chips(container, values, className) {
  container.replaceChildren(
    ...(values ?? []).map((value) => {
      const el = document.createElement("span");
      el.className = className;

      const src = portraits.get(value);
      if (src) {
        // The class changes the BOX: a text chip has padding and variable
        // width; a portrait one is a square. Without this the image comes out
        // distorted inside the chip's padding.
        el.classList.add("has-art");

        const img = document.createElement("img");
        img.className = `${className}-img`;
        img.src = src;
        img.alt = "";
        // A broken image live looks worse than the name in text.
        img.addEventListener(
          "error",
          () => {
            el.classList.remove("has-art");
            el.textContent = value;
          },
          { once: true }
        );
        el.append(img);
      } else {
        el.textContent = value; // textContent, never innerHTML
      }
      return el;
    })
  );
}

/**
 * Flag as an emoji, derived from the ISO alpha-2 code.
 *
 * No CDN and no country table: Unicode regional indicators compose
 * the flag from the two letters. A strange code simply paints
 * nothing, which live is the correct behavior.
 */
function flagEmoji(country) {
  if (!/^[A-Z]{2}$/.test(country ?? "")) return "";
  return [...country].map((c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65)).join("");
}

function renderSide(key, side) {
  $(`[data-flag-${key}]`).textContent = flagEmoji(side?.country);
  $(`[data-sponsor-${key}]`).textContent = side?.sponsor ?? "";
  renderRoster(key, side);
  $(`[data-name-${key}]`).textContent = side?.name ?? "";
  $(`[data-score-${key}]`).textContent = String(side?.score ?? 0);
  document.querySelector(`[data-side="${key}"]`).dataset.losers = String(Boolean(side?.losers));
  chips($(`[data-chars-${key}]`), side?.chars, "char");

  // The accent color is decided by the operator per side.
  if (side?.color) {
    document.documentElement.style.setProperty(`--${key}`, side.color);
  }

  // Versus screen.
  $(`[data-vs-flag-${key}]`).textContent = flagEmoji(side?.country);
  $(`[data-vs-sponsor-${key}]`).textContent = side?.sponsor ?? "";
  $(`[data-vs-name-${key}]`).textContent = side?.name ?? "";
  chips($(`[data-vs-chars-${key}]`), side?.chars, "vs-char");
}

function renderCasters(casters) {
  const host = $("[data-casters]");
  host.replaceChildren(
    ...(casters ?? [])
      .filter((c) => c?.name)
      .map((c) => {
        const box = document.createElement("div");
        box.className = "caster";

        const name = document.createElement("div");
        name.className = "caster-name";
        name.textContent = c.name;

        const handle = document.createElement("div");
        handle.className = "caster-handle";
        handle.textContent = c.handle ?? "";

        box.append(name, handle);
        return box;
      })
  );
}

/**
 * Roster under the scoreboard — doubles and crew battle.
 *
 * A duel side does not carry it and paints nothing; a doubles side carries `players`
 * (two, with their flag); a crew side carries `roster` with stocks. It is decided by the
 * SHAPE of the data, not by the profile id: that way a third party's profile with the
 * same shape works without touching this file.
 */
function renderRoster(key, side) {
  const host = $(`[data-roster-${key}]`);
  if (!host) return;

  const crew = side?.roster;
  const pair = side?.players;

  if (Array.isArray(crew) && crew.length) {
    host.hidden = false;
    host.replaceChildren(
      ...crew.map((m) => {
        const row = document.createElement("div");
        row.className = "crew-member";
        row.dataset.out = m.out ? "1" : "0";
        row.dataset.active = m.active ? "1" : "0";

        const name = document.createElement("span");
        name.className = "crew-name";
        name.textContent = `${flagEmoji(m.country)} ${m.name}`.trim();

        const stocks = document.createElement("span");
        stocks.className = "crew-stocks";
        // Dots, not numbers: stocks are counted at a glance.
        stocks.textContent = m.out ? "✕" : "●".repeat(Math.min(m.stocksLeft ?? 0, 9));

        row.append(name, stocks);
        return row;
      })
    );
    return;
  }

  if (Array.isArray(pair) && pair.length) {
    host.hidden = false;
    host.replaceChildren(
      ...pair.map((p) => {
        const row = document.createElement("div");
        row.className = "pair-member";
        row.textContent = `${flagEmoji(p.country)} ${p.name}${p.char ? ` · ${p.char}` : ""}`.trim();
        return row;
      })
    );
    return;
  }

  host.hidden = true;
}

/**
 * Set result screen.
 *
 * The K.O. is a two-second dramatic effect; this is what is left up
 * while the caster summarizes. Without it, closing a set only left going back to the
 * scoreboard with the final score frozen, which does not tell someone who has just
 * joined the stream who won.
 *
 * The winner is DEDUCED from the score, which the operator has already been keeping: it is
 * the same criterion used to report to the bracket, so the screen and the
 * bracket cannot say different things.
 */
function renderResult(state, visible) {
  if (!visible) return;

  const a = state.players?.a ?? {};
  const b = state.players?.b ?? {};
  const winner = (a.score ?? 0) >= (b.score ?? 0) ? a : b;
  const side = winner === a ? "a" : "b";

  const name = [winner.sponsor, winner.name].filter(Boolean).join(" ");
  $("[data-result-name]").textContent = name;
  $("[data-result-name]").style.color = `var(--${side})`;
  $("[data-result-score]").textContent = `${a.score ?? 0} — ${b.score ?? 0}`;

  // What they won with: in FGC the character is part of the set's story.
  chips($("[data-result-chars]"), winner.chars, "vs-char");
}

/**
 * Top banner. Appears when there is a message and goes away when it is removed.
 *
 * Scrolling is only activated if the text does NOT fit in the bar: the CSS
 * needs to know how much it overflows, and that is measured here after painting.
 */
function renderTicker(text) {
  const host = $("[data-ticker]");
  host.textContent = text ?? "";
  layer("ticker").hidden = !text;
  if (!text) return;

  // Measure AFTER painting: until then scrollWidth is that of the old text.
  requestAnimationFrame(() => {
    const bar = host.parentElement;
    const overflow = host.scrollWidth - bar.clientWidth;
    host.dataset.scroll = overflow > 8 ? "1" : "0";
    if (overflow > 8) {
      host.style.setProperty("--ticker-shift", `${-overflow - 26}px`);
    }
  });
}

/** Applies a complete overlay state. */
function render(state) {
  if (!state) return;

  renderSide("a", state.players?.a);
  renderSide("b", state.players?.b);
  renderCasters(state.casters);

  $("[data-round]").textContent = state.event?.round ?? "";
  $("[data-ft]").textContent = state.event?.firstTo ? `FIRST TO ${state.event.firstTo}` : "";
  $("[data-vs-event]").textContent = state.event?.title ?? "";

  renderTicker(state.ticker);

  const flags = state.flags ?? {};
  renderResult(state, flags.result);

  // The versus, the K.O. and the result are full screens: they cover the
  // scoreboard. Leaving it underneath looks like a production failure.
  const fullscreen = flags.versus || flags.ko || flags.result;
  layer("scoreboard").hidden = Boolean(fullscreen);
  layer("versus").hidden = !flags.versus;
  layer("ko").hidden = !flags.ko;
  layer("result").hidden = !flags.result;
  layer("casters").hidden = !flags.casters;

  // Marks that data is now present: until here the CSS keeps everything invisible so as not to
  // show a scoreboard at zero during startup.
  document.body.dataset.ready = "1";
}

// ── State ────────────────────────────────────────────────────────────────────

/** Asks for the snapshot. Used at startup and after each reconnection. */
async function loadSnapshot() {
  if (!MATCH_ID) {
    console.warn("[broadcast-overlay] missing ?match=<id> in the URL");
    return;
  }
  try {
    const res = await fetch(`${API}/broadcast/overlay/${encodeURIComponent(MATCH_ID)}`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const payload = await res.json();
    // The snapshot carries its own revision: if the WebSocket has already moved ahead, it is not
    // overwritten with earlier data.
    if (typeof payload.revision === "number" && payload.revision < revision) return;

    revision = typeof payload.revision === "number" ? payload.revision : revision;
    render(payload.data);
  } catch (err) {
    console.error("[broadcast-overlay] could not load the state:", err.message);
  }
}

/** Applies a channel message, discarding late ones. */
function applyMessage(message) {
  if (!message || message.type !== "state:sync") return;
  if (message.key !== `broadcast:match:${MATCH_ID}`) return;

  // THIS line is what keeps the scoreboard from going backwards live.
  if (typeof message.revision === "number" && message.revision <= revision) return;

  revision = message.revision;
  render(message.value);
}

// ── Connection ───────────────────────────────────────────────────────────────

let socket = null;
let retry = 0;
let reconnectTimer = null;

function setConnected(ok) {
  conn.hidden = ok;
}

function connect() {
  if (!MATCH_ID) return;

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const channel = `state:broadcast:match:${MATCH_ID}`;
  const url = `${proto}//${location.host}/ws?channel=${encodeURIComponent(channel)}`;

  try {
    socket = new WebSocket(url);
  } catch {
    return scheduleReconnect();
  }

  socket.addEventListener("open", () => {
    retry = 0;
    setConnected(true);
    // Explicit subscription: the server decides whether this client may listen to
    // this channel — unlike NodeCG, where replicants are global.
    socket.send(JSON.stringify({ type: "subscribe", channel }));
    // On reconnecting, everything that happened in the meantime was lost.
    void loadSnapshot();
  });

  socket.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(event.data);
      // The transport may wrap the message or send it plain.
      applyMessage(data?.message ?? data);
    } catch {
      // An unreadable message cannot bring the graphic down.
    }
  });

  socket.addEventListener("close", () => {
    setConnected(false);
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    try {
      socket.close();
    } catch {
      /* the close will already trigger the reconnection */
    }
  });
}

/**
 * Exponential backoff capped at 10 s.
 *
 * Without a cap, a long outage would leave the graphic waiting for minutes; without backoff,
 * a downed server would receive a storm of reconnections from every overlay.
 */
function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(500 * 2 ** retry++, 10_000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

// ── Startup ──────────────────────────────────────────────────────────────────

// The roster is loaded BEFORE the first snapshot: if it arrived afterwards, the first
// render would come out with text and then switch to portraits in front of the audience.
void loadRoster().then(() => {
  void loadSnapshot();
  connect();
});

// If OBS puts the tab in the background and it comes back, it resynchronizes.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void loadSnapshot();
});
