/**
 * MOBA overlay — render and transport
 * ============================================================================
 *
 * Plain JS, no framework and no build, like the rest of the project's graphics.
 *
 * **Nothing is computed here.** Not dragon souls, nor timers, nor MVP,
 * nor gold difference. All of that arrives already resolved in the state, because it is
 * tested on the server and this file runs inside OBS, where there are no
 * tests, no console anyone watches and a failure goes on air.
 *
 * All that is done here is paint and keep the connection alive.
 */

const params = new URLSearchParams(location.search);
const GAME_ID = params.get("game");
const API = params.get("api") || "/api";
/** Layers to show. Lets the same overlay be used in several OBS sources. */
const ONLY = (params.get("layers") || "").split(",").filter(Boolean);

const $ = (sel) => document.querySelector(sel);
const layer = (name) => document.querySelector(`[data-layer="${name}"]`);

let revision = -1;

// ── Utilities ────────────────────────────────────────────────────────────────

function clock(seconds) {
  const safe = Math.max(0, Math.floor(seconds ?? 0));
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, "0")}`;
}

/** Thousands with a thin separator. A 12400 on screen reads "12.4k". */
function kgold(value) {
  const abs = Math.abs(value);
  if (abs < 1000) return String(Math.round(value));
  return `${(value / 1000).toFixed(1)}k`;
}

function show(name, visible) {
  const el = layer(name);
  if (!el) return;
  // `?layers=` limits which layers appear in this OBS source. Without the parameter
  // all are shown.
  el.hidden = !visible || (ONLY.length > 0 && !ONLY.includes(name));
}

/** Creates an element with text. `textContent`, never `innerHTML`. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

// ── Assets ───────────────────────────────────────────────────────────────────

/**
 * Data Dragon: the public CDN that Riot publishes precisely for this.
 *
 * Nothing needs to be hosted nor permission asked; it is the same origin the client
 * itself uses. The version is resolved at startup against `versions.json` because
 * icons change with the patch: pinning it by hand leaves new items without an image
 * within days.
 */
const DDRAGON = "https://ddragon.leagueoflegends.com";
let ddVersion = null;

async function resolveAssetVersion() {
  try {
    const res = await fetch(`${DDRAGON}/api/versions.json`, { cache: "no-store" });
    const versions = await res.json();
    if (Array.isArray(versions) && versions[0]) ddVersion = versions[0];
  } catch {
    // Without a version portraits are not painted, but the rest of the overlay continues: the
    // scoreboard and times are what cannot be missing.
  }
  return ddVersion;
}

const championArt = (key) =>
  ddVersion && key ? `${DDRAGON}/cdn/${ddVersion}/img/champion/${key}.png` : null;

const itemArt = (id) =>
  ddVersion && id && id !== "0" ? `${DDRAGON}/cdn/${ddVersion}/img/item/${id}.png` : null;

/**
 * Image that does not break the graphic if the CDN fails.
 *
 * `onerror` hides it instead of leaving the broken-image icon, which live
 * looks worse than an empty gap.
 */
function art(src, className) {
  if (!src) return null;
  const img = document.createElement("img");
  img.className = className;
  img.loading = "eager";
  img.src = src;
  img.alt = "";
  img.addEventListener("error", () => (img.style.display = "none"), { once: true });
  return img;
}

/**
 * A logo address the overlay may load, or null.
 *
 * Team and sponsor logos are addresses someone typed in a form. Only `http:`, `https:` (a
 * relative path resolves to the overlay's own origin) and inline images (`data:image/…`) go
 * into an `src`; anything else (`javascript:`, `file:`, a `data:` that is not an image, a
 * value that is not text) counts as "no logo", which every caller already handles.
 */
function logoSrc(value) {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  if (/^data:/i.test(text)) return /^data:image\/[a-z0-9.+-]+[;,]/i.test(text) ? text : null;
  try {
    const url = new URL(text, location.href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

// ── Theme ────────────────────────────────────────────────────────────────────

/** Applies the series theme as CSS variables. */
function applyTheme(theme, teams) {
  const root = document.documentElement.style;
  if (teams?.blue?.color) root.setProperty("--blue", teams.blue.color);
  if (teams?.red?.color) root.setProperty("--red", teams.red.color);
  if (!theme) return;

  if (theme.accent) root.setProperty("--accent", theme.accent);
  if (theme.surface) {
    // The CSS needs the color as components so it can apply opacity to it.
    const hex = theme.surface.replace("#", "");
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    if ([r, g, b].every(Number.isFinite)) root.setProperty("--surface", `${r}, ${g}, ${b}`);
  }
  if (typeof theme.surfaceOpacity === "number") {
    root.setProperty("--surface-opacity", String(theme.surfaceOpacity));
  }
  root.setProperty("--radius", theme.corners === "soft" ? "4px" : "0px");
  if (theme.fontFamily) root.setProperty("--font", theme.fontFamily);
}

// ── Scoreboard ───────────────────────────────────────────────────────────────

function renderMatchbar(state) {
  const { teams, series, comparison } = state;

  for (const side of ["blue", "red"]) {
    const team = teams?.[side] ?? {};
    $(`[data-tag-${side}]`).textContent = team.tag || team.name || "";

    const logo = $(`[data-logo-${side}]`);
    const logoUrl = logoSrc(team.logoUrl);
    logo.hidden = !logoUrl;
    if (logoUrl) logo.src = logoUrl;

    $(`[data-kills-${side}]`).textContent = String(comparison?.kills?.[side] ?? 0);

    // Series markers: as many dots as wins are needed.
    const needed = Math.ceil((series?.bestOf ?? 1) / 2);
    const won = side === "blue" ? (series?.blueScore ?? 0) : (series?.redScore ?? 0);
    const dots = $(`[data-dots-${side}]`);
    dots.replaceChildren(
      ...Array.from({ length: needed }, (_, i) => {
        const d = el("span", "dot");
        d.dataset.won = i < won ? "1" : "0";
        d.style.color = `var(--${side})`;
        return d;
      })
    );
  }

  $("[data-clock]").textContent = clock(state.clock);
  $("[data-stage]").textContent = series?.stage || series?.title || "";

  // Each layer shows itself: that is what makes `?layers=` work
  // the same for all of them and means none is left unshown by oversight.
  show("matchbar", true);
}

// ── Gold ─────────────────────────────────────────────────────────────────────

/** What the thing being measured is called. They are not synonyms. */
const WEALTH_LABELS = {
  networth: "Net worth",
  gold: "Gold difference",
  "estimated-gold": "Gold difference",
};

function renderGold(state) {
  const gold = state.comparison?.gold;
  if (!gold) return show("gold", false);

  // The label changes with what is really being measured: net worth
  // —the price of what they carry, exact— is not gold earned, and calling it
  // the same would be lying to the caster in a different way.
  $("[data-gold-label]").textContent = WEALTH_LABELS[gold.basis] ?? "Lead";

  const value = $("[data-gold-diff]");
  const diff = gold.diff ?? 0;
  value.textContent = `${diff >= 0 ? "+" : "−"}${kgold(Math.abs(diff))}`;
  value.style.color = diff > 0 ? "var(--blue)" : diff < 0 ? "var(--red)" : "var(--ink-dim)";

  // The estimate mark only appears when the number REALLY is one. With
  // net worth it is not shown: it is arithmetic on data the API delivers.
  value.classList.toggle("estimated", gold.precision === "estimated");

  renderGoldChart(state.goldSeries ?? [], diff);
  show("gold", true);
}

/**
 * Difference chart, drawn as an SVG path.
 *
 * Symmetric scale around zero with a minimum of 2,000 gold: without that
 * floor, a lead of 200 at minute 2 would fill the chart and look like a
 * blowout.
 */
function renderGoldChart(series, current) {
  const path = $("[data-gold-path]");
  if (!series.length) return path.setAttribute("d", "");

  const W = 460;
  const H = 46;
  const MIN_SCALE = 2000;

  const peak = Math.max(MIN_SCALE, ...series.map((p) => Math.abs(p.diff)));
  const lastAt = series[series.length - 1].at || 1;

  const points = series.map((p) => {
    const x = (p.at / lastAt) * W;
    const y = H / 2 - (p.diff / peak) * (H / 2 - 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });

  path.setAttribute("d", `M${points.join("L")}`);
  path.setAttribute("stroke", current >= 0 ? "var(--blue)" : "var(--red)");
}

// ── Objectives ───────────────────────────────────────────────────────────────

/**
 * Draft slug → Data Dragon key.
 *
 * In the draft the champions are typed by the operator, so there is no
 * `rawChampionName` to extract the exact key from. Capitalizing gets the
 * vast majority right; the odd cases (Wukong) are written as-is and the image's
 * `onerror` leaves the text.
 */
function toKey(slug) {
  if (!slug) return null;
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

const TIMER_LABELS = { dragon: "Dragon", baron: "Baron", herald: "Herald", voidgrub: "Voidgrubs" };

function renderObjectives(state) {
  const timers = state.objectives?.timers ?? [];
  const host = $("[data-timers]");

  host.replaceChildren(
    ...timers
      // An objective that will not return is removed, not painted gray: on screen
      // gray is confused with "no data yet".
      .filter((t) => t.countdown !== null)
      .map((t) => {
        const row = el("div", "timer-row");
        row.dataset.available = t.available ? "1" : "0";
        row.dataset.soon = !t.available && t.countdown <= 30 ? "1" : "0";
        row.append(
          el("span", "timer-label", TIMER_LABELS[t.kind] ?? t.kind),
          el("span", "timer-value", t.available ? "ON MAP" : clock(t.countdown))
        );
        return row;
      })
  );

  const soul = state.objectives?.soul;
  const soulEl = $("[data-soul]");
  if (soul?.holder) {
    soulEl.hidden = false;
    soulEl.replaceChildren(el("span", null, `Soul ${soul.type ?? ""} · ${soul.holder}`));
    soulEl.style.color = `var(--${soul.holder})`;
  } else if (soul?.onPoint) {
    // "One dragon away" changes how the next five minutes are played.
    soulEl.hidden = false;
    soulEl.replaceChildren(el("span", null, `One dragon from soul · ${soul.onPoint}`));
    soulEl.style.color = `var(--${soul.onPoint})`;
  } else {
    soulEl.hidden = true;
  }

  show("objectives", timers.length > 0);
}

// ── Players ──────────────────────────────────────────────────────────────────

function renderPlayers(state) {
  for (const side of ["blue", "red"]) {
    const name = side === "blue" ? "players" : "players-red";
    const host = layer(name);
    const players = state.players?.[side] ?? [];

    host.replaceChildren(
      ...players.map((p) => {
        const row = el("div", "player");
        row.dataset.dead = p.isDead ? "1" : "0";

        const portrait = el("div", "portrait");
        // The portrait is what makes this look like a broadcast and
        // not a table. If the CDN does not respond, the abbreviation below remains.
        const face = art(championArt(p.championKey), "portrait-img");
        portrait.append(face ?? el("span", null, (p.championId ?? "").slice(0, 3).toUpperCase()));
        portrait.append(el("span", "level", p.level));
        if (p.isDead && p.respawnIn > 0) {
          portrait.append(el("span", "respawn", p.respawnIn));
        }

        const info = el("div");
        info.append(
          el("div", "player-name", p.riotId || p.championName || ""),
          el("div", "player-sub", `${p.creepScore} CS`)
        );

        // Items are painted as slots, without a portrait: without an image CDN,
        // showing the item number adds nothing for the viewer.
        if (state.precision?.items === "exact" && p.items?.length) {
          const items = el("div", "items");
          items.append(
            ...p.items.slice(0, 6).map((id) => {
              const slot = el("span", "item");
              const icon = art(itemArt(id), "item-img");
              if (icon) slot.append(icon);
              return slot;
            })
          );
          info.append(items);
        }

        row.append(portrait, info, el("div", "kda", `${p.kills}/${p.deaths}/${p.assists}`));
        return row;
      })
    );

    host.style.setProperty("--accent", `var(--${side})`);
    show(name, players.length > 0);
  }
}

// ── Draft ────────────────────────────────────────────────────────────────────

function renderDraft(state) {
  const draft = state.draft;
  if (!draft || draft.complete) return show("draft", false);

  $("[data-draft-blue]").textContent = state.teams?.blue?.tag ?? "";
  $("[data-draft-red]").textContent = state.teams?.red?.tag ?? "";

  for (const side of ["blue", "red"]) {
    const picks = draft.picks?.[side] ?? [];
    const awaiting = draft.awaiting;

    const host = $(`[data-picks-${side}]`);
    host.replaceChildren(
      ...Array.from({ length: 5 }, (_, i) => {
        const pick = el("div", "pick");
        const key = picks[i];
        const face = art(championArt(toKey(key)), "pick-img");
        if (face) pick.append(face);
        pick.append(el("span", null, key ?? "—"));
        // The slot being waited on is the only thing animated on the whole screen.
        const isNext = awaiting?.action === "pick" && awaiting.team === side && i === picks.length;
        pick.dataset.awaiting = isNext ? "1" : "0";
        pick.style.borderColor = isNext ? `var(--${side})` : "transparent";
        return pick;
      })
    );

    const bans = draft.bans?.[side] ?? [];
    $(`[data-bans-${side}]`).replaceChildren(
      ...Array.from({ length: 5 }, (_, i) => {
        const ban = el("div", "ban");
        const face = art(championArt(toKey(bans[i])), "ban-img");
        if (face) ban.append(face);
        else if (bans[i]) ban.append(el("span", null, bans[i].slice(0, 3).toUpperCase()));
        // Skipped ban (explicit null) ≠ turn that has not arrived yet.
        ban.dataset.passed = i < bans.length && bans[i] === null ? "1" : "0";
        return ban;
      })
    );
  }

  show("draft", true);
}

// ── Pre-game screen ──────────────────────────────────────────────────────────

/**
 * Countdown before starting.
 *
 * Shown when the state carries `countdown` and the game has not started yet. It is
 * air time that would otherwise stay black: people join the stream
 * before the hour and what they see first decides whether they stay.
 */
function renderPregame(state) {
  const seconds = state.countdown;
  if (seconds === null || seconds === undefined) return show("pregame", false);

  $("[data-pre-stage]").textContent = state.series?.stage || state.series?.title || "";
  $("[data-countdown]").textContent = clock(seconds);
  $("[data-pre-format]").textContent = state.series?.bestOf
    ? `BEST OF ${state.series.bestOf}`
    : "";

  for (const side of ["blue", "red"]) {
    const team = state.teams?.[side] ?? {};
    $(`[data-pre-${side}]`).textContent = team.name || team.tag || "";
    const logo = $(`[data-pre-logo-${side}]`);
    const logoUrl = logoSrc(team.logoUrl);
    logo.hidden = !logoUrl;
    if (logoUrl) logo.src = logoUrl;
  }

  show("pregame", true);
  return true;
}

// ── Post-game ────────────────────────────────────────────────────────────────

function renderPostgame(state) {
  if (state.status !== "finished") return show("postgame", false);

  const winner = state.comparison?.gold?.diff >= 0 ? "blue" : "red";
  $("[data-winner]").textContent = state.teams?.[winner]?.name ?? "";
  $("[data-winner]").style.color = `var(--${winner})`;

  const box = $("[data-mvp]");
  if (state.mvp?.player) {
    box.hidden = false;
    $("[data-mvp-name]").textContent = state.mvp.player.riotId || state.mvp.player.championName;
    $("[data-mvp-reasons]").textContent = (state.mvp.reasons ?? []).join(" · ");
  } else {
    box.hidden = true;
  }

  show("postgame", true);
}

// ── Rest ─────────────────────────────────────────────────────────────────────

function renderTimeline(state) {
  const entries = state.timeline ?? [];
  layer("timeline").replaceChildren(
    ...entries.slice(-6).map((e) => {
      const box = el("div", "tl panel");
      box.append(el("span", "tl-at", clock(e.at)), el("span", null, e.label));
      if (e.team) box.style.borderBottom = `2px solid var(--${e.team})`;
      return box;
    })
  );
  show("timeline", entries.length > 0);
}

function renderCasters(state) {
  const casters = (state.casters ?? []).filter((c) => c?.name);
  layer("casters").replaceChildren(
    ...casters.map((c) => {
      const box = el("div", "caster panel");
      box.append(el("div", "caster-name", c.name), el("div", "caster-handle", c.handle ?? ""));
      return box;
    })
  );
  show("casters", casters.length > 0);
}

function renderSponsors(state) {
  const sponsors = state.sponsors ?? [];
  layer("sponsors").replaceChildren(
    ...sponsors.map((s) => {
      // A logo that may not be loaded leaves the sponsor's name, like a sponsor without logo.
      const logoUrl = logoSrc(s.logoUrl);
      if (logoUrl) {
        const img = document.createElement("img");
        img.src = logoUrl;
        img.alt = s.name ?? "";
        const box = el("div", "sponsor");
        box.append(img);
        return box;
      }
      return el("div", "sponsor", s.name ?? "");
    })
  );
  show("sponsors", sponsors.length > 0);
}

// ── Render ───────────────────────────────────────────────────────────────────

function render(state) {
  if (!state) return;

  applyTheme(state.theme, state.teams);

  const drafting = Boolean(state.draft && !state.draft.complete);
  const finished = state.status === "finished";
  // The countdown overrides everything else: if it has not started yet, there is no
  // game to show.
  const waiting = renderPregame(state) === true;

  renderDraft(state);
  renderPostgame(state);

  // The pre-game, the draft and the post-game are FULL screens: they cover the
  // HUD. Leaving the scoreboard underneath looks like a production error.
  const hud = !waiting && !drafting && !finished;
  // With the pre-game on air, the draft is also hidden: they are two full
  // screens and there can only be one.
  if (waiting) show("draft", false);

  if (hud) {
    renderMatchbar(state);
    renderGold(state);
    renderObjectives(state);
    renderPlayers(state);
    renderTimeline(state);
  } else {
    for (const name of ["matchbar", "gold", "objectives", "players", "players-red", "timeline"]) {
      show(name, false);
    }
  }

  renderCasters(state);
  renderSponsors(state);

  // Source-down notice, only in the operator's preview.
  $("[data-source-lost]").hidden = Boolean(state.source) || !hud;

  document.body.dataset.ready = "1";
}

// ── Transport ────────────────────────────────────────────────────────────────

async function loadSnapshot() {
  if (!GAME_ID) {
    console.warn("[moba-overlay] missing ?game=<id> in the URL");
    return;
  }
  try {
    const res = await fetch(`${API}/broadcast/live/overlay/${encodeURIComponent(GAME_ID)}`, {
      credentials: "same-origin",
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const payload = await res.json();
    if (typeof payload.revision === "number" && payload.revision < revision) return;
    revision = typeof payload.revision === "number" ? payload.revision : revision;
    render(payload.data);
  } catch (err) {
    console.error("[moba-overlay] could not load the state:", err.message);
  }
}

function applyMessage(message) {
  if (!message || message.type !== "state:sync") return;
  if (message.key !== `moba:game:${GAME_ID}`) return;
  // This line is what keeps the scoreboard from going backwards after a reconnection.
  if (typeof message.revision === "number" && message.revision <= revision) return;

  revision = message.revision;
  render(message.value);
}

let socket = null;
let retry = 0;
let reconnectTimer = null;

function connect() {
  if (!GAME_ID) return;

  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const channel = `state:moba:game:${GAME_ID}`;
  const url = `${proto}//${location.host}/ws?channel=${encodeURIComponent(channel)}`;

  try {
    socket = new WebSocket(url);
  } catch {
    return scheduleReconnect();
  }

  socket.addEventListener("open", () => {
    retry = 0;
    $("[data-conn]").hidden = true;
    socket.send(JSON.stringify({ type: "subscribe", channel }));
    void loadSnapshot();
  });

  socket.addEventListener("message", (event) => {
    try {
      const data = JSON.parse(event.data);
      applyMessage(data?.message ?? data);
    } catch {
      // An unreadable message cannot bring the graphic down.
    }
  });

  socket.addEventListener("close", () => {
    $("[data-conn]").hidden = false;
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    try {
      socket.close();
    } catch {
      /* the close already triggers the reconnection */
    }
  });
}

/** Exponential backoff capped at 10 s. */
function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(500 * 2 ** retry++, 10_000);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

// The asset version is resolved BEFORE the first snapshot: if it arrived
// afterwards, the first render would come out without portraits and the change would be visible.
void resolveAssetVersion().then(() => {
  void loadSnapshot();
  connect();
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void loadSnapshot();
});
