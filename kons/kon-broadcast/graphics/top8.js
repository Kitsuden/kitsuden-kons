/**
 * Top 8 — render of the final stretch of the bracket
 * ============================================================================
 *
 * Plain JS, no framework and no build, like the rest of the graphics.
 *
 * Bracket is not computed here either: it arrives resolved from the esports
 * public endpoint (`/matches/tournament/:id/bracket`), which already includes the
 * name map. This file only chooses WHICH rounds to show and paints them.
 *
 * Polling, not WebSocket: a bracket changes every few minutes. Keeping a live
 * channel for that is infrastructure with no return; 20 seconds of polling are
 * invisible to the audience.
 */

const params = new URLSearchParams(location.search);
const TOURNAMENT = params.get("tournament");
const API = params.get("api") || "/api";
const POLL_MS = Number(params.get("poll") || 20_000);

const $ = (sel) => document.querySelector(sel);

/** Emoji flag from ISO alpha-2. No CDN or country table. */
function flagEmoji(country) {
  if (!/^[A-Z]{2}$/.test(country ?? "")) return "";
  return [...country].map((c) => String.fromCodePoint(0x1f1e6 + c.charCodeAt(0) - 65)).join("");
}

/**
 * Rounds to show per side.
 *
 * A "top 8" is the FINAL STRETCH of the bracket, whatever its size: the last
 * two winners rounds, the last three losers rounds and the grand final. In an
 * 8-player bracket that is exactly the classic top 8; in a 32-player one, the final
 * weekend. Choosing by "round from the end" makes the same graphic
 * serve both with no configuration.
 */
function tail(matches, keep) {
  const rounds = [...new Set(matches.map((m) => m.round))].sort((a, b) => a - b);
  const shown = rounds.slice(-keep);
  return shown.map((round) => matches.filter((m) => m.round === round));
}

/** Readable name of a round, counting from the end of the side. */
function roundName(side, fromEnd) {
  const names =
    side === "winners"
      ? ["Winners Final", "Winners Semifinal", "Winners Cuartos"]
      : ["Losers Final", "Losers Semifinal", "Losers Cuartos"];
  return names[fromEnd] ?? `${side === "winners" ? "Winners" : "Losers"}`;
}

function slot(el, participantId, match, names) {
  const row = document.createElement("div");
  row.className = "slot";

  const entry = participantId ? names[participantId] : null;
  const flag = document.createElement("span");
  flag.className = "flag";
  flag.textContent = flagEmoji(entry?.country);

  const who = document.createElement("span");
  who.className = "who";
  // An empty slot is normal in a bracket in progress: TBD is painted, the
  // set is not hidden — the slot IS the information that a result is missing.
  who.textContent = entry?.name || "TBD";

  row.dataset.won = participantId && match.winnerId === participantId ? "1" : "0";
  row.append(flag, who);
  el.append(row);
}

function column(label, matches, names) {
  const col = document.createElement("div");
  col.className = "col";

  const head = document.createElement("div");
  head.className = "col-label";
  head.textContent = label;
  col.append(head);

  for (const m of matches) {
    // A set voided by byes does not exist: painting it would show an empty box
    // that looks like a data failure.
    if (m.status === "void") continue;
    const box = document.createElement("div");
    box.className = "match";
    slot(box, m.participants[0], m, names);
    slot(box, m.participants[1], m, names);
    col.append(box);
  }
  return col;
}

function render(data) {
  const names = data.names ?? {};

  $("[data-subtitle]").textContent =
    `Double elimination · ${data.size} participants` + (data.complete ? " · FINISHED" : "");

  // ── Winners + gran final ──
  const winnersHost = $("[data-winners]");
  winnersHost.replaceChildren();

  const winnerCols = tail(data.winners ?? [], 2);
  winnerCols.forEach((matches, i) => {
    winnersHost.append(column(roundName("winners", winnerCols.length - 1 - i), matches, names));
  });

  // The grand final goes in the winners band: it is where that band flows into.
  const gf = (data.grandFinal ?? []).filter((m) => m.status !== "void");
  if (gf.length) {
    const col = column("Grand Final", gf, names);

    if (data.championId && names[data.championId]) {
      const champ = document.createElement("div");
      champ.className = "champion";
      champ.textContent = `🏆 ${names[data.championId].name}`;
      col.append(champ);
    }
    winnersHost.append(col);
  }

  // ── Losers ──
  const losersHost = $("[data-losers]");
  losersHost.replaceChildren();
  const loserCols = tail(data.losers ?? [], 3);
  loserCols.forEach((matches, i) => {
    losersHost.append(column(roundName("losers", loserCols.length - 1 - i), matches, names));
  });

  document.body.dataset.ready = "1";
}

async function refresh() {
  if (!TOURNAMENT) {
    console.warn("[top8] missing ?tournament=<id> in the URL");
    return;
  }
  try {
    const res = await fetch(
      `${API}/esports/matches/tournament/${encodeURIComponent(TOURNAMENT)}/bracket`,
      { credentials: "same-origin", cache: "no-store" }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    render(await res.json());
  } catch (err) {
    // The last painted state is kept: a 20-second-old bracket is better
    // than a flicker to black from a one-off network failure.
    console.error("[top8] could not refresh:", err.message);
  }
}

void refresh();
setInterval(() => void refresh(), POLL_MS);

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refresh();
});
