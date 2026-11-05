/**
 * Group standings — table render
 * ============================================================================
 *
 * Tiebreakers are NOT computed here: they arrive resolved from the standings
 * endpoint, where they are tested. This file only paints rows — and the order
 * they arrive in IS the standings, including the shared position when the
 * tie is unbreakable.
 *
 * `?advance=N` marks the first N positions as the advancement zone (the cutoff
 * of a pool). It is presentation, not data: how many advance is decided by the tournament
 * format, not the engine.
 */

const params = new URLSearchParams(location.search);
const TOURNAMENT = params.get("tournament");
const API = params.get("api") || "/api";
const POLL_MS = Number(params.get("poll") || 20_000);
const ADVANCE = Number(params.get("advance") || 0);

const $ = (sel) => document.querySelector(sel);

/** Emoji flag from ISO alpha-2. No CDN or country table. */
function flagEmoji(country) {
  if (!/^[A-Z]{2}$/.test(country ?? "")) return "";
  return [...country].map((c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65)).join("");
}

function cell(className, text) {
  const td = document.createElement("td");
  td.className = className;
  td.textContent = text;
  return td;
}

function render(data) {
  $("[data-title]").textContent = data.title || "STANDINGS";
  $("[data-subtitle]").textContent =
    `${data.rounds} rounds` + (data.complete ? " · FINISHED" : "");

  const rows = $("[data-rows]");
  rows.replaceChildren(
    ...(data.standings ?? []).map((s) => {
      const tr = document.createElement("tr");
      tr.dataset.advances = ADVANCE > 0 && s.position <= ADVANCE ? "1" : "0";

      const entry = data.names?.[s.participantId];
      const who = cell("who", "");
      const flag = document.createElement("span");
      flag.textContent = flagEmoji(entry?.country);
      const name = document.createElement("span");
      name.textContent = entry?.name || "—";
      who.replaceChildren(flag, name);

      const diff = s.gamesWon - s.gamesLost;
      const diffCell = cell("diff", `${diff > 0 ? "+" : ""}${diff}`);
      diffCell.dataset.positive = diff > 0 ? "1" : "0";

      tr.append(
        cell("pos", String(s.position)),
        who,
        cell("record", String(s.played)),
        cell("record", String(s.wins)),
        cell("record", String(s.losses)),
        diffCell
      );
      return tr;
    })
  );

  document.body.dataset.ready = "1";
}

async function refresh() {
  if (!TOURNAMENT) {
    console.warn("[standings] missing ?tournament=<id> in the URL");
    return;
  }
  try {
    const res = await fetch(
      `${API}/esports/matches/tournament/${encodeURIComponent(TOURNAMENT)}/standings`,
      { credentials: "same-origin", cache: "no-store" }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render(await res.json());
  } catch (err) {
    // What was painted is kept: a table from 20 s ago is better than a flicker.
    console.error("[standings] could not refresh:", err.message);
  }
}

void refresh();
setInterval(() => void refresh(), POLL_MS);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refresh();
});
