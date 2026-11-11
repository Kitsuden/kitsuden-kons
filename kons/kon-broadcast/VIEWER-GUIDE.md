# How to broadcast like the LEC while spectating from your PC

> This guide used to live in `kon-broadcast-moba`, which was merged into `kon-broadcast`:
> the two kons had the same container under different names. What used to be a separate
> kon is now the **live section** of Broadcast, which you switch on when
> needed. Routes moved from `/api/broadcast-moba/...` to
> `/api/broadcast/...`; a series is a broadcast set (`/api/broadcast/matches`) and each game of
> it is a row under `/api/broadcast/games`.
>
> It needs the `games`, `draft` and `live` sections switched on. If they are not,
> the API answers **409** saying which one is missing and which line to add to the grimoire;
> check it with `GET /api/broadcast/sections`.

A complete recipe, from zero to live. It assumes the League client is on the
same machine you broadcast from and that Kitsuden runs somewhere else.

---

## What you need to understand first

The LEC does **not** overlay its graphics on top of the game HUD: it **REPLACES** it.

If you look at a capture of a professional broadcast, League's native scoreboard
is not there. Neither the objectives bar, nor the side portraits, nor the default
minimap. All of that is hidden and a custom graphic sits in its place.

That is the difference between looking like a broadcast and looking like a stream with things
pasted on top. And it is free: you just have to turn off the native HUD.

---

## 1. Spectate and turn off the native HUD

Join the game as a spectator. Once inside, **Ctrl+Shift+O** opens the
spectator options menu; in the interface tab you can turn off separately:

- Top scoreboard
- Team status bars
- Side champion portraits
- Objective counters

Leave the minimap and the in-world health bars visible — the LEC keeps those too,
because they are part of reading the game.

If your scene only needs the clean game, **Ctrl+O** hides the entire
interface in one go.

> Shortcuts and option names change between patches. If one does not
> respond, they are all in the spectator menu.

---

## 2. Create the series and the game

Every call below except the agent's push needs a session or an agent key. The examples send an
agent key with `Authorization: Bearer $KEY`; the key needs `broadcast:create` to create the set and
`broadcast:update` for the rest (an admin or editor account in the browser works too). Creating
the set needs an admin or editor; the rest needs the set's owner or an admin.

```bash
curl -X POST https://YOUR-SERVER/api/broadcast/matches \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{
    "eventTitle": "MY LEAGUE",
    "round": "WEEK 3",
    "bestOf": 3,
    "profileId": "lol",
    "sideA": { "name": "Karmine Corp", "tag": "KC", "color": "#00b4d8",
               "roster": [{ "name": "Top" }, { "name": "Jungle" }, { "name": "Mid" }, { "name": "ADC" }, { "name": "Support" }] },
    "sideB": { "name": "G2 Esports", "tag": "G2", "color": "#ee3d23",
               "roster": [{ "name": "Top" }, { "name": "Jungle" }, { "name": "Mid" }, { "name": "ADC" }, { "name": "Support" }] }
  }'
```

The `lol` profile wants exactly five players per side (`roster`, each with a `name` and optional
`role`), a `tag` of up to 8 characters and a `#rrggbb` color. Without `profileId` the set takes
the grimoire's `gameProfile`, or the generic `1v1` duel, whose sides have a different shape. The
profile cannot be changed later.

And then the game:

```bash
curl -X POST https://YOUR-SERVER/api/broadcast/matches/<matchId>/games \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{}'
```

Save the game's `id`: it is the one that goes in the overlay URL and in the agent.

From the admin panel (**Live booth**) you do the same with buttons, and
it also generates ready-to-copy OBS URLs.

---

## 3. Start the agent

The server cannot read the `127.0.0.1:2999` of your PC — a self-signed certificate,
mixed content and missing CORS prevent it in three different ways. That is why the data
flows the other way: your PC pushes it.

Request the token:

```bash
curl -X POST https://YOUR-SERVER/api/broadcast/games/<gameId>/ingest/push-token \
  -H "Authorization: Bearer $KEY"
```

The token is shown once. Asking again issues a new one and revokes the old one. It only lets the
agent push frames to that game, through the `X-Broadcast-Ingest-Token` header.

And start the agent (it is in `tools/agent.mjs`, no dependencies, Node 18 or later):

```bash
node agent.mjs --url https://YOUR-SERVER --game <gameId> --token <token>
```

You will see the game clock advancing. Until the game loads it only prints its
two start-up lines (`MOBA agent · game …` and `Reading … every …ms`) and no clock —
that is normal, it connects by itself once the game starts. `· no game` appears
only after a game it was reading ends or the client closes.

Finally, tell the server that the source is the agent:

```bash
curl -X POST https://YOUR-SERVER/api/broadcast/games/<gameId>/ingest/start \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"adapterId":"push"}'
```

Without `adapterId` the server uses `riot-live-client`, which reads `127.0.0.1:2999` on the
server itself: that only works when the API and the game client run on the same machine.
`GET /api/broadcast/live/adapters` lists the registered sources.

When the game ends, stop the session and close the game with the side that won it (blue or red of
THIS game; the point goes to the right side of the series):

```bash
curl -X POST https://YOUR-SERVER/api/broadcast/games/<gameId>/ingest/stop -H "Authorization: Bearer $KEY"
curl -X POST https://YOUR-SERVER/api/broadcast/games/<gameId>/finish \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' -d '{"winner":"blue"}'
```

---

## 4. Set up the scene in OBS

A scene with two sources, **in this order from top to bottom**:

| Order | Source             | What it is        |
| ----- | ------------------ | ----------------- |
| 1     | **Browser Source** | Your overlay      |
| 2     | **Game Capture**   | League of Legends |

The Browser Source goes **on top**. Configure it like this:

- **URL:** `https://YOUR-SERVER/api/kons/kon-broadcast/graphics/overlay-live.html?game=<gameId>`
- **Width:** 1920 · **Height:** 1080
- ✅ **Shutdown source when not visible**
- ✅ **Refresh browser when scene becomes active**
- **Custom CSS:** leave it empty. The overlay already has a transparent background.

And in Game Capture, **specific window mode** pointing at
`League of Legends (TM) Client` — full-screen mode sometimes captures
the overlay too and it gets duplicated.

### Splitting the overlay into several sources

If you want the scoreboard in one scene and the draft in another, the `layers` parameter
trims it:

```
…/overlay-live.html?game=<gameId>&layers=matchbar
…/overlay-live.html?game=<gameId>&layers=gold,objectives
…/overlay-live.html?game=<gameId>&layers=draft
…/overlay-live.html?game=<gameId>&layers=postgame
```

Without the parameter you get the full overlay. The layer names are `matchbar`, `gold`,
`objectives`, `players`, `players-red`, `timeline`, `draft`, `pregame`, `postgame`, `casters` and
`sponsors`.

---

## 5. Putting your identity on it

What separates "it looks good" from "it looks like a league" is that the graphic is
**yours**, not someone else's. All of this changes without touching code:

```bash
curl -X PATCH https://YOUR-SERVER/api/broadcast/matches/<matchId> \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{
    "theme": {
      "accent": "#00d2a8",
      "surface": "#05070c",
      "surfaceOpacity": 0.9,
      "corners": "sharp",
      "fontFamily": "Rajdhani, sans-serif"
    },
    "sponsors": [{ "name": "MY SPONSOR", "logoUrl": "https://…/logo.png" }],
    "casters": [{ "name": "Your Name", "handle": "@yourhandle" }]
  }'
```

- **`accent`** is the production's color; each team's go in
  `sideA.color` and `sideB.color`.
- **`fontFamily`** has to be installed on the PC that broadcasts: OBS uses the
  system fonts. Condensed ones (Rajdhani, Barlow Condensed, Saira) are
  the ones that give the esports look.
- **`surfaceOpacity`** below 0.8 lets too much of the game show through and the
  text loses legibility; above 0.95 it covers like an opaque block.

Sponsor logos (`sponsors[].logoUrl`) are `http(s)` URLs or inline `data:image/…` images (at most 8
sponsors); any other address is not loaded and the sponsor shows by name. Team sides have no logo field:
a team is shown by its `tag`, `name` and `color`.

---

## 6. Check before going live

- [ ] The native HUD is off and does not show underneath the overlay
- [ ] The agent shows the clock advancing
- [ ] In the overlay: champion portraits visible (if not, the CDN is not responding)
- [ ] The corner notice "No game data" does **not** appear
- [ ] Team colors are correct on their side
- [ ] The series scoreboard shows the right points

---

## What you won't be able to match, and why

- **Exact gold.** The LEC gets it from the tournament server. You have the
  **net worth**, which is exact and is what gets compared live. What is missing
  is the unspent gold.
- **Player cameras.** They are physical cameras in the booth, not data.
- **Visualizations in the 3D world.** They need access to the game camera.
- **Spectator delay.** Your client has it; the LEC broadcasts without it.

None of that is noticeable in a community stream. What is noticeable —and is what
this guide solves— is having the native HUD peeking out from under your graphic.
