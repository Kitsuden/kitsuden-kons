/**
 * Saving a whole game from the panel (`PATCH /api/games/:id` with `blocks`)
 * cannot erase the `editorial` layer left by Inti's edits: the one for each
 * block with the same id is kept, just like on reloads.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROUTES = readFileSync(
  resolve(__dirname, "../../kons/kon-games/games.routes.ts"),
  "utf8"
);

describe("saving the whole game keeps what was edited with Inti", () => {
  it("the game's PATCH passes the blocks through sqlBlocksWithEditorial", () => {
    // From the SDK, the `update-game` operation (PATCH /:id)
    const start = ROUTES.indexOf('id: "update-game"');
    expect(start).toBeGreaterThan(-1);
    const patch = ROUTES.slice(start);
    const body = patch.slice(0, patch.indexOf(".returning()"));
    expect(body).toContain("columnUpdates.blocks = sqlBlocksWithEditorial(columnUpdates.blocks)");
  });
});
