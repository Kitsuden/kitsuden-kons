/**
 * kon-dc — blueprint templates
 * ============================================================================
 *
 * Ready-made blueprints, installed as DRAFTS (`POST /templates/:id/install`) and then edited like any
 * other: they are data in the same format, not special code. Each takes a few settings (validated by
 * its `options` schema, which the panel draws as a form).
 *
 *   broadcast-booth — the operator's booth for kon-broadcast in Discord (what Viggo's bot did, for any
 *                     game): `/booth` commands, a live panel with buttons and selects that redraws on
 *                     `broadcast:match:updated`, a modal to edit names, start.gg import, role gate.
 *   feedback-form   — `/feedback` opens a modal; the answer goes to a staff channel.
 *   loot-box        — `/lootbox` (or a panel button) spends coins on weighted drops into the inventory.
 *   quiz            — `/quiz ask`: the first member to answer right wins coins and XP.
 *
 * The booth calls kon-broadcast with the BOT's agent key (DISCORD_KITSUDEN_API_TOKEN). Give that key
 * the booth's scopes and no more: BOOTH_SCOPES below.
 */

import { z } from "zod";

import { BlueprintDefinition, Snowflake, type BlueprintDefinitionInput } from "./dc.contract";

/** The fine scopes the bot's key needs for the broadcast booth. */
export const BOOTH_SCOPES = [
  "kon:broadcast:list-sets",
  "kon:broadcast:get-set",
  "kon:broadcast:update-set",
  "kon:broadcast:scoreboard",
  "kon:broadcast:screens",
  "kon:broadcast:swap-sides",
  "kon:broadcast:reset-set",
  "kon:broadcast:startgg-sets",
  "kon:broadcast:apply-startgg-set",
] as const;

export interface BlueprintTemplate<O extends z.ZodType = z.ZodType> {
  id: string;
  name: string;
  description: string;
  /** Other kons it calls, and the scopes the bot's key needs for them. */
  needs: { kons: string[]; scopes: readonly string[] };
  options: O;
  build(options: z.output<O>): BlueprintDefinitionInput;
}

const defineTemplate = <O extends z.ZodType>(t: BlueprintTemplate<O>) => t;

const SIDES = [
  { name: "A (left)", value: "a" },
  { name: "B (right)", value: "b" },
];

const ROUNDS = [
  "Pools",
  "Winners Round 1",
  "Winners Quarter-Final",
  "Winners Semi-Final",
  "Winners Final",
  "Losers Round 1",
  "Losers Quarter-Final",
  "Losers Semi-Final",
  "Losers Final",
  "Grand Final",
  "Grand Final Reset",
  "Exhibition",
];

/** `{{option.side}}` → the side key in kon-broadcast's body. Two guarded steps, one per side. */
function perSide(body: (key: "sideA" | "sideB") => Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return (["a", "b"] as const).map((s) => ({
    do: "kon_call" as const,
    if: { left: "{{option.side}}", op: "eq" as const, right: s },
    method: "PATCH" as const,
    path: "/broadcast/matches/{{kv.set}}",
    body: { [s === "a" ? "sideA" : "sideB"]: body(s === "a" ? "sideA" : "sideB"), ...extra },
  }));
}

/** Toggle a screen when no value is given; set it when one is. */
function screenSteps(screen: "versus" | "ko" | "casters") {
  return [
    {
      do: "kon_call" as const,
      if: { left: "{{option.show}}", op: "not_empty" as const },
      method: "POST" as const,
      path: "/broadcast/matches/{{kv.set}}/screens",
      body: { [screen]: "{{option.show}}" },
    },
    {
      do: "kon_call" as const,
      if: { left: "{{option.show}}", op: "empty" as const },
      path: "/broadcast/matches/{{kv.set}}",
      saveAs: "m",
    },
    {
      do: "kon_call" as const,
      if: { left: `{{call.m.data.screens.${screen}}}`, op: "eq" as const, right: "true" },
      method: "POST" as const,
      path: "/broadcast/matches/{{kv.set}}/screens",
      body: { [screen]: false },
    },
    {
      do: "kon_call" as const,
      if: { left: `{{call.m.data.screens.${screen}}}`, op: "eq" as const, right: "false" },
      method: "POST" as const,
      path: "/broadcast/matches/{{kv.set}}/screens",
      body: { [screen]: true },
    },
  ];
}

const noSet = {
  do: "reply" as const,
  if: { left: "{{kv.set}}", op: "empty" as const },
  content: "Pick the set first: `/booth set`.",
  ephemeral: true,
};

const done = (content: string) => ({ do: "reply" as const, content, ephemeral: true });

export const broadcastBooth = defineTemplate({
  id: "broadcast-booth",
  name: "Broadcast booth",
  description:
    "Run a kon-broadcast scoreboard from Discord: /booth commands, a live panel with score buttons, screen toggles, round and character selects, an edit form and start.gg import. Any game: the characters come from the kon's roster.",
  needs: { kons: ["kon-broadcast"], scopes: BOOTH_SCOPES },
  options: z
    .object({
      operatorRoleIds: z
        .array(Snowflake)
        .max(10)
        .default([])
        .meta({ title: "Operator role ids", description: "Who may operate; empty = anyone in the server" }),
      picksPerSide: z
        .number()
        .int()
        .min(1)
        .max(3)
        .default(1)
        .meta({ title: "Characters per side", description: "2 for tag games" }),
    })
    .strict(),
  build({ operatorRoleIds, picksPerSide }) {
    const access = operatorRoleIds.length ? { roles: operatorRoleIds, message: "Only the stream operators can do that." } : undefined;
    const withAccess = <T extends object>(c: T) => (access ? { ...c, access } : c);
    const score = (side: "a" | "b", delta: number) =>
      withAccess({
        type: "button" as const,
        id: `${side}-${delta > 0 ? "up" : "down"}`,
        label: `${side.toUpperCase()} ${delta > 0 ? "+1" : "−1"}`,
        style: delta > 0 ? ("success" as const) : ("secondary" as const),
        steps: [{ do: "kon_call" as const, method: "POST" as const, path: "/broadcast/matches/{{kv.set}}/score", body: { side, delta } }],
      });
    const screen = (id: "versus" | "ko" | "casters", label: string) =>
      withAccess({
        type: "button" as const,
        id: `toggle-${id}`,
        label,
        style: "primary" as const,
        steps: [
          { do: "kon_call" as const, path: "/broadcast/matches/{{kv.set}}", saveAs: "m" },
          {
            do: "kon_call" as const,
            method: "POST" as const,
            path: "/broadcast/matches/{{kv.set}}/screens",
            if: { left: `{{call.m.data.screens.${id}}}`, op: "eq" as const, right: "true" },
            body: { [id]: false },
          },
          {
            do: "kon_call" as const,
            method: "POST" as const,
            path: "/broadcast/matches/{{kv.set}}/screens",
            if: { left: `{{call.m.data.screens.${id}}}`, op: "neq" as const, right: "true" },
            body: { [id]: true },
          },
        ],
      });
    const charSelect = (side: "a" | "b") =>
      withAccess({
        type: "select" as const,
        id: `chars-${side}`,
        placeholder: `Characters, side ${side.toUpperCase()}`,
        optionsFrom: { path: "/broadcast/champions", items: "data", label: "{{item.name}}", value: "{{item.slug}}" },
        minValues: 0,
        maxValues: picksPerSide,
        steps: [
          {
            do: "kon_call" as const,
            method: "PATCH" as const,
            path: "/broadcast/matches/{{kv.set}}",
            body: { [side === "a" ? "sideA" : "sideB"]: { chars: "{{values_list}}" } },
          },
        ],
      });
    const characterOption = (name: string, description: string) => ({
      name,
      description,
      type: "string" as const,
      autocomplete: { path: "/broadcast/champions", items: "data", label: "{{item.name}}", value: "{{item.slug}}" },
    });

    const definition: BlueprintDefinitionInput = {
      commands: [
        {
          name: "booth",
          description: "Run the stream's scoreboard",
          ...(access ? { access } : {}),
          subcommands: [
            {
              name: "set",
              description: "Choose the broadcast set this server operates",
              options: [
                {
                  name: "set",
                  description: "The set",
                  type: "string",
                  required: true,
                  autocomplete: {
                    path: "/broadcast/matches",
                    items: "docs",
                    label: "{{item.eventTitle}} · {{item.round}} · {{item.sideA.name}} vs {{item.sideB.name}}",
                    value: "{{item.id}}",
                  },
                },
              ],
              steps: [
                { do: "kon_call", path: "/broadcast/matches/{{option.set}}", saveAs: "m" },
                { do: "kv_set", key: "set", value: "{{option.set}}" },
                { do: "refresh_panels" },
                done("Now operating **{{call.m.data.eventTitle}}** · {{call.m.data.round}}."),
              ],
            },
            {
              name: "panel",
              description: "Post the live control panel here",
              steps: [{ do: "post_panel", panel: "booth", channelId: "$channel" }, done("Panel posted. It updates by itself.")],
            },
            {
              name: "event",
              description: "Event title, round and first-to",
              options: [
                { name: "title", description: "Event title", type: "string", maxLength: 80 },
                { name: "round", description: "Round", type: "string", choices: ROUNDS.map((r) => ({ name: r, value: r })) },
                { name: "firstto", description: "First to (1–9)", type: "integer", min: 1, max: 9 },
              ],
              steps: [
                noSet,
                {
                  do: "kon_call",
                  if: { left: "{{kv.set}}", op: "not_empty" },
                  method: "PATCH",
                  path: "/broadcast/matches/{{kv.set}}",
                  body: { eventTitle: "{{option.title}}", round: "{{option.round}}", firstTo: "{{option.firstto}}" },
                },
                done("Event updated."),
              ],
            },
            {
              name: "player",
              description: "Gamertag, sponsor and losers flag of one side",
              options: [
                { name: "side", description: "Side", type: "string", required: true, choices: SIDES },
                { name: "name", description: "Gamertag", type: "string", maxLength: 40 },
                { name: "sponsor", description: "Sponsor tag", type: "string", maxLength: 20 },
                { name: "losers", description: "Comes from losers", type: "boolean" },
              ],
              steps: [noSet, ...perSide(() => ({ name: "{{option.name}}", sponsor: "{{option.sponsor}}", losers: "{{option.losers}}" })), done("Player updated.")],
            },
            {
              name: "score",
              description: "Set a side's score",
              options: [
                { name: "side", description: "Side", type: "string", required: true, choices: SIDES },
                { name: "value", description: "Score (0–99)", type: "integer", required: true, min: 0, max: 99 },
              ],
              steps: [
                noSet,
                { do: "kon_call", method: "POST", path: "/broadcast/matches/{{kv.set}}/score", body: { side: "{{option.side}}", value: "{{option.value}}" } },
                done("Score set."),
              ],
            },
            {
              name: "point",
              description: "Add (or take) a point",
              options: [
                { name: "side", description: "Side", type: "string", required: true, choices: SIDES },
                { name: "delta", description: "+1 by default; -1 to take one", type: "integer", min: -9, max: 9 },
              ],
              steps: [
                noSet,
                {
                  do: "kon_call",
                  if: { left: "{{option.delta}}", op: "empty" },
                  method: "POST",
                  path: "/broadcast/matches/{{kv.set}}/score",
                  body: { side: "{{option.side}}", delta: 1 },
                },
                {
                  do: "kon_call",
                  if: { left: "{{option.delta}}", op: "not_empty" },
                  method: "POST",
                  path: "/broadcast/matches/{{kv.set}}/score",
                  body: { side: "{{option.side}}", delta: "{{option.delta}}" },
                },
                done("Point."),
              ],
            },
            {
              name: "chars",
              description: "Characters of one side (none = clear)",
              options: [
                { name: "side", description: "Side", type: "string", required: true, choices: SIDES },
                characterOption("first", "Character"),
                ...(picksPerSide > 1 ? [characterOption("second", "Second character")] : []),
                ...(picksPerSide > 2 ? [characterOption("third", "Third character")] : []),
              ],
              steps: [noSet, ...perSide(() => ({ chars: ["{{option.first}}", "{{option.second}}", "{{option.third}}"] })), done("Characters updated.")],
            },
            {
              name: "swap",
              description: "Swap sides (colors stay on their seat)",
              steps: [noSet, { do: "kon_call", method: "POST", path: "/broadcast/matches/{{kv.set}}/swap?keepColors=true" }, done("Sides swapped.")],
            },
            {
              name: "versus",
              description: "Show or hide the versus screen (toggles without a value)",
              options: [{ name: "show", description: "Show it", type: "boolean" }],
              steps: [noSet, ...screenSteps("versus"), done("Versus screen updated.")],
            },
            {
              name: "ko",
              description: "Show or hide the K.O. banner (toggles without a value)",
              options: [{ name: "show", description: "Show it", type: "boolean" }],
              steps: [noSet, ...screenSteps("ko"), done("K.O. updated.")],
            },
            {
              name: "casters",
              description: "Show or hide the casters lower third (toggles without a value)",
              options: [{ name: "show", description: "Show it", type: "boolean" }],
              steps: [noSet, ...screenSteps("casters"), done("Casters updated.")],
            },
            {
              name: "caster",
              description: "Name and handle of a caster",
              options: [
                { name: "slot", description: "Caster 1 or 2", type: "integer", required: true, choices: [{ name: "1", value: 1 }, { name: "2", value: 2 }] },
                { name: "name", description: "Name", type: "string", required: true, maxLength: 40 },
                { name: "handle", description: "Handle (with or without @)", type: "string", maxLength: 40 },
              ],
              steps: [
                noSet,
                { do: "kon_call", path: "/broadcast/matches/{{kv.set}}", saveAs: "m" },
                {
                  do: "kon_call",
                  if: { left: "{{option.slot}}", op: "eq", right: "1" },
                  method: "PATCH",
                  path: "/broadcast/matches/{{kv.set}}",
                  body: { casters: [{ name: "{{option.name}}", handle: "{{option.handle}}" }, "{{call.m.data.casters.1}}"] },
                },
                {
                  do: "kon_call",
                  if: { left: "{{option.slot}}", op: "eq", right: "2" },
                  method: "PATCH",
                  path: "/broadcast/matches/{{kv.set}}",
                  body: { casters: ["{{call.m.data.casters.0}}", { name: "{{option.name}}", handle: "{{option.handle}}" }] },
                },
                done("Caster {{option.slot}} updated."),
              ],
            },
            {
              name: "reset",
              description: "Scores to zero and screens off for the next set",
              options: [{ name: "players", description: "Also clear the players", type: "boolean" }],
              steps: [
                noSet,
                {
                  do: "kon_call",
                  if: { left: "{{option.players}}", op: "eq", right: "true" },
                  method: "POST",
                  path: "/broadcast/matches/{{kv.set}}/reset?players=clear",
                },
                {
                  do: "kon_call",
                  if: { left: "{{option.players}}", op: "neq", right: "true" },
                  method: "POST",
                  path: "/broadcast/matches/{{kv.set}}/reset",
                },
                done("Set reset."),
              ],
            },
            {
              name: "startgg",
              description: "Load a set from a start.gg event",
              options: [{ name: "event", description: "Event URL or slug (tournament/…/event/…)", type: "string", required: true }],
              steps: [
                noSet,
                {
                  do: "kon_call",
                  if: { left: "{{kv.set}}", op: "not_empty" },
                  method: "POST",
                  path: "/broadcast/startgg/sets",
                  body: { event: "{{option.event}}" },
                  saveAs: "sg",
                },
                {
                  do: "reply",
                  if: { left: "{{kv.set}}", op: "not_empty" },
                  ephemeral: true,
                  content: "**{{call.sg.event}}**: pick the set to put on the scoreboard.",
                  components: [
                    [
                      withAccess({
                        type: "select" as const,
                        id: "startgg-pick",
                        placeholder: "Set",
                        optionsFrom: {
                          scope: "call.sg.sets",
                          label: "{{item.entrants.0}} vs {{item.entrants.1}}",
                          value: "{{item.id}}",
                          description: "{{item.round}} · {{item.state}}",
                        },
                        steps: [
                          {
                            do: "kon_call" as const,
                            method: "POST" as const,
                            path: "/broadcast/matches/{{kv.set}}/startgg",
                            body: { setId: "{{value}}" },
                            saveAs: "r",
                          },
                          {
                            do: "update_message" as const,
                            content: "Loaded **{{call.r.data.sideA.name}}** vs **{{call.r.data.sideB.name}}** · {{call.r.data.round}}.",
                          },
                        ],
                      }),
                    ],
                  ],
                },
              ],
            },
            {
              name: "status",
              description: "What is on the scoreboard now",
              steps: [
                noSet,
                { do: "kon_call", if: { left: "{{kv.set}}", op: "not_empty" }, path: "/broadcast/matches/{{kv.set}}", saveAs: "m" },
                {
                  do: "reply",
                  if: { left: "{{kv.set}}", op: "not_empty" },
                  ephemeral: true,
                  embeds: [
                    {
                      title: "{{call.m.data.eventTitle}}",
                      description: "{{call.m.data.round}} · first to {{call.m.data.firstTo}} · {{call.m.data.status}}",
                      fields: [
                        { name: "{{call.m.data.sideA.sponsor}} {{call.m.data.sideA.name}}", value: "**{{call.m.data.sideA.score}}**", inline: true },
                        { name: "{{call.m.data.sideB.sponsor}} {{call.m.data.sideB.name}}", value: "**{{call.m.data.sideB.score}}**", inline: true },
                      ],
                      footer: "Set {{kv.set}}",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
      modals: [
        {
          id: "edit",
          title: "Edit the set",
          ...(access ? { access } : {}),
          inputs: [
            { id: "title", label: "Event title (blank = keep)", style: "short", maxLength: 80 },
            { id: "name_a", label: "Side A gamertag", style: "short", maxLength: 40 },
            { id: "sponsor_a", label: "Side A sponsor", style: "short", maxLength: 20 },
            { id: "name_b", label: "Side B gamertag", style: "short", maxLength: 40 },
            { id: "sponsor_b", label: "Side B sponsor", style: "short", maxLength: 20 },
          ],
          steps: [
            {
              do: "kon_call",
              method: "PATCH",
              path: "/broadcast/matches/{{kv.set}}",
              body: {
                eventTitle: "{{input.title}}",
                sideA: { name: "{{input.name_a}}", sponsor: "{{input.sponsor_a}}" },
                sideB: { name: "{{input.name_b}}", sponsor: "{{input.sponsor_b}}" },
              },
            },
          ],
        },
      ],
      panels: [
        {
          id: "booth",
          data: { m: "/broadcast/matches/{{kv.set}}" },
          refreshOn: ["broadcast:match:updated"],
          embeds: [
            {
              title: "{{data.m.data.eventTitle}}",
              description: "{{data.m.data.round}} · first to {{data.m.data.firstTo}}",
              color: 0x5865f2,
              fields: [
                { name: "{{data.m.data.sideA.sponsor}} {{data.m.data.sideA.name}}", value: "# {{data.m.data.sideA.score}}", inline: true },
                { name: "{{data.m.data.sideB.sponsor}} {{data.m.data.sideB.name}}", value: "# {{data.m.data.sideB.score}}", inline: true },
                {
                  name: "On screen",
                  value: "Versus: {{data.m.data.screens.versus}} · K.O.: {{data.m.data.screens.ko}} · Casters: {{data.m.data.screens.casters}}",
                },
              ],
              footer: "Updates by itself · /booth set to change the set",
            },
          ],
          components: [
            [score("a", -1), score("a", 1), withAccess({ type: "button" as const, id: "swap", label: "Swap", style: "secondary" as const, steps: [{ do: "kon_call" as const, method: "POST" as const, path: "/broadcast/matches/{{kv.set}}/swap?keepColors=true" }] }), score("b", -1), score("b", 1)],
            [
              screen("versus", "Versus"),
              screen("ko", "K.O."),
              screen("casters", "Casters"),
              withAccess({ type: "button" as const, id: "edit", label: "Edit", style: "secondary" as const, steps: [{ do: "open_modal" as const, modal: "edit" }] }),
              withAccess({
                type: "button" as const,
                id: "reset",
                label: "Reset",
                style: "danger" as const,
                steps: [{ do: "kon_call" as const, method: "POST" as const, path: "/broadcast/matches/{{kv.set}}/reset" }],
              }),
            ],
            [
              withAccess({
                type: "select" as const,
                id: "round",
                placeholder: "Round",
                options: ROUNDS.map((r) => ({ label: r, value: r })),
                steps: [{ do: "kon_call" as const, method: "PATCH" as const, path: "/broadcast/matches/{{kv.set}}", body: { round: "{{value}}" } }],
              }),
            ],
            [charSelect("a")],
            [charSelect("b")],
          ],
        },
      ],
    };
    return definition;
  },
});

export const feedbackForm = defineTemplate({
  id: "feedback-form",
  name: "Feedback form",
  description: "/feedback opens a form; what members send arrives in a staff channel with who sent it.",
  needs: { kons: [], scopes: [] },
  options: z.object({ staffChannelId: Snowflake.meta({ title: "Staff channel id", description: "Where the answers arrive" }) }).strict(),
  build: ({ staffChannelId }) => ({
    commands: [{ name: "feedback", description: "Send feedback to the staff", steps: [{ do: "open_modal", modal: "feedback" }] }],
    modals: [
      {
        id: "feedback",
        title: "Feedback",
        inputs: [
          { id: "topic", label: "Topic", style: "short", required: true, maxLength: 80 },
          { id: "text", label: "What would you like to tell us?", style: "paragraph", required: true, maxLength: 1500 },
        ],
        steps: [
          {
            do: "send_message",
            channelId: staffChannelId,
            embeds: [{ title: "{{input.topic}}", description: "{{input.text}}", footer: "From {{user.name}} ({{user.id}})", color: 0x57f287 }],
          },
          { do: "reply", content: "Thanks, the staff got it.", ephemeral: true },
        ],
      },
    ],
  }),
});

const RARITIES = [
  { id: "common", label: "Common", color: "#95a5a6" },
  { id: "rare", label: "Rare", color: "#3498db" },
  { id: "legendary", label: "Legendary", color: "#f1c40f" },
] as const;

export const lootBox = defineTemplate({
  id: "loot-box",
  name: "Loot box",
  description:
    "/lootbox (or a panel button) spends coins on a box with weighted drops: common, rare and legendary gems in the inventory. Uses the server's shared coins.",
  needs: { kons: [], scopes: [] },
  options: z
    .object({
      price: z.number().int().min(0).max(1_000_000).default(100).meta({ title: "Price in coins" }),
      commonWeight: z.number().int().min(0).max(1000).default(70).meta({ title: "Common: weight" }),
      rareWeight: z.number().int().min(0).max(1000).default(25).meta({ title: "Rare: weight" }),
      legendaryWeight: z.number().int().min(0).max(1000).default(5).meta({ title: "Legendary: weight" }),
    })
    .strict()
    .refine((o) => o.commonWeight + o.rareWeight + o.legendaryWeight > 0, { message: "At least one weight above 0" }),
  build: ({ price, commonWeight, rareWeight, legendaryWeight }) => {
    const weights: Record<string, number> = { common: commonWeight, rare: rareWeight, legendary: legendaryWeight };
    const total = commonWeight + rareWeight + legendaryWeight;
    const rarities = RARITIES.filter((r) => weights[r.id] > 0);
    const open = () => [
      { do: "wallet_take" as const, amount: price, else: `A loot box costs 🪙 ${price}. Try /daily or /work.` },
      { do: "random" as const, saveAs: "drop", pick: rarities.map((r) => ({ value: r.id, weight: weights[r.id] })) },
      ...rarities.flatMap((r) => [
        { do: "item_add" as const, if: { left: "{{var.drop}}", op: "eq" as const, right: r.id }, item: `gem-${r.id}`, saveAs: "count" },
        { do: "set_var" as const, if: { left: "{{var.drop}}", op: "eq" as const, right: r.id }, name: "color", value: r.color },
      ]),
      { do: "emit_event" as const, name: "lootbox:opened", data: { rarity: "{{var.drop}}" } },
      {
        do: "reply" as const,
        ephemeral: true,
        embeds: [
          {
            title: "📦 You opened a loot box!",
            description: "You got a **{{var.drop|title}} gem**: you have {{var.count}} {{var.count|plural:gem,gems}} of that kind.",
            color: "{{var.color}}",
          },
        ],
      },
    ];
    return {
      commands: [
        { name: "lootbox", description: `Open a loot box (🪙 ${price})`, steps: open() },
        {
          name: "lootbox-panel",
          description: "Staff: post the loot box panel here",
          defaultPermissions: ["manage_guild"],
          access: { permissions: ["manage_guild"] },
          steps: [
            { do: "post_panel", panel: "box", channelId: "$channel" },
            { do: "reply", ephemeral: true, content: "Posted." },
          ],
        },
      ],
      panels: [
        {
          id: "box",
          embeds: [
            {
              title: "📦 Loot boxes",
              description: `Open one for 🪙 ${price}: ${rarities.map((r) => `${r.label} ${Math.round((weights[r.id] / total) * 100)}%`).join(" · ")}`,
              color: 0xf1c40f,
            },
          ],
          components: [[{ type: "button", id: "open", label: `Open (🪙 ${price})`, style: "primary", emoji: "📦", steps: open() }]],
        },
      ],
    };
  },
});

export const quiz = defineTemplate({
  id: "quiz",
  name: "Quiz",
  description: "/quiz ask posts a question; the first member to answer right (in a form) wins coins and XP, and the card says who won.",
  needs: { kons: [], scopes: [] },
  options: z
    .object({ xp: z.number().int().min(0).max(100_000).default(50).meta({ title: "XP for the winner", description: "Counted by the Levels module" }) })
    .strict(),
  build: ({ xp }) => ({
    commands: [
      {
        name: "quiz",
        description: "Quiz",
        access: { permissions: ["manage_guild"], message: "Only the staff asks questions." },
        defaultPermissions: ["manage_guild"],
        subcommands: [
          {
            name: "ask",
            description: "Staff: ask a question here",
            options: [
              { name: "question", description: "The question", type: "string", required: true, maxLength: 300 },
              { name: "answer", description: "The right answer (not shown)", type: "string", required: true, maxLength: 100 },
              { name: "prize", description: "Coins for the winner", type: "integer", required: true, min: 0, max: 1_000_000 },
            ],
            steps: [
              { do: "stop", if: { left: "{{kv.open}}", op: "eq", right: "yes" }, content: "A question is still open." },
              { do: "kv_set", key: "q", value: "{{option.question}}" },
              { do: "kv_set", key: "a", value: "{{option.answer|lower|trim}}" },
              { do: "kv_set", key: "prize", value: "{{option.prize}}" },
              { do: "kv_set", key: "open", value: "yes" },
              { do: "kv_set", key: "claims", value: 0 },
              { do: "kv_set", key: "status", value: `First right answer wins 🪙 {{option.prize}}${xp ? ` and ${xp} XP` : ""}` },
              { do: "post_panel", panel: "quiz", channelId: "$channel" },
              { do: "reply", ephemeral: true, content: "Asked." },
            ],
          },
        ],
      },
    ],
    panels: [
      {
        id: "quiz",
        embeds: [{ title: "❓ {{kv.q}}", description: "{{kv.status}}", color: 0x5865f2 }],
        components: [
          [
            {
              type: "button",
              id: "answer",
              label: "Answer",
              style: "primary",
              disabledIf: { left: "{{kv.open}}", op: "neq", right: "yes" },
              steps: [{ do: "open_modal", modal: "answer" }],
            },
          ],
        ],
      },
    ],
    modals: [
      {
        id: "answer",
        title: "Your answer",
        inputs: [{ id: "guess", label: "Answer", required: true, maxLength: 100 }],
        steps: [
          { do: "stop", if: { left: "{{kv.open}}", op: "neq", right: "yes" }, content: "Too late, someone got it first!" },
          { do: "stop", if: { left: "{{input.guess|lower|trim}}", op: "neq", right: "{{kv.a}}" }, content: "Not quite. Try again!" },
          // Two right answers at the same instant: the counter is one SQL write, only the first gets 1.
          { do: "kv_increment", key: "claims", by: 1 },
          { do: "stop", if: { left: "{{kv.claims}}", op: "neq", right: "1" }, content: "Too late, someone got it first!" },
          { do: "kv_set", key: "open", value: "no" },
          { do: "wallet_add", amount: "{{kv.prize}}" },
          ...(xp > 0 ? [{ do: "wallet_add" as const, currency: "xp", amount: xp }] : []),
          { do: "kv_set", key: "status", value: "🎉 Won by {{user.mention}}: the answer was **{{kv.a}}**" },
          { do: "refresh_panels", panel: "quiz" },
          { do: "send_message", channelId: "$channel", content: "🎉 {{user.mention}} got it: **{{kv.a}}** (+🪙 {{kv.prize}})" },
          { do: "reply", ephemeral: true, content: "Correct!" },
        ],
      },
    ],
  }),
});

export const TEMPLATES: BlueprintTemplate[] = [
  broadcastBooth as BlueprintTemplate,
  feedbackForm as BlueprintTemplate,
  lootBox as BlueprintTemplate,
  quiz as BlueprintTemplate,
];

/** A template's definition with its settings, validated like any blueprint. */
export function buildTemplate(template: BlueprintTemplate, raw: unknown) {
  const options = template.options.parse(raw ?? {});
  return BlueprintDefinition.parse(template.build(options));
}
