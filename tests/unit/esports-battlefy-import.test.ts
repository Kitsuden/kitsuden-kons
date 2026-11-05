/**
 * Battlefy importer (by file)
 * ============================================================================
 *
 * Battlefy answers `Direct API access is not permitted` to anyone who
 * calls its API, so here the export that the organizer
 * downloads themselves is read. That changes what can go wrong: it is no longer the network, it is the file.
 *
 *   · A team name with commas splits the row into pieces.
 *   · The file went through Excel on Windows and carries `\r` stuck to every field.
 *   · The headers are not the same between games or between versions.
 *   · There is no identifier, and nobody warns that reimporting will duplicate.
 */

import { describe, expect, test } from "vitest";

import {
  importFromBattlefyExport,
  parseCsvLine,
} from "../../kons/kon-esports/importers/battlefy";
import { ImportError } from "../../kons/kon-esports/importers/import.types";

describe("splitting CSV", () => {
  test("the usual case", () => {
    expect(parseCsvLine("a,b,c")).toEqual(["a", "b", "c"]);
  });

  test("a comma INSIDE quotes does not split the field", () => {
    // It is the real case: team names carry commas.
    expect(parseCsvLine('1,"Team Liquid, EU",3')).toEqual(["1", "Team Liquid, EU", "3"]);
  });

  test("a doubled quote is a literal quote", () => {
    expect(parseCsvLine('1,"El ""Rey"" del Norte"')).toEqual(["1", 'El "Rey" del Norte']);
  });

  test("empty fields are kept in their place", () => {
    // Losing them would shift all the following columns.
    expect(parseCsvLine("a,,c")).toEqual(["a", "", "c"]);
  });
});

describe("importing a CSV", () => {
  const csv = ["userID,name,seed,country", "u1,Ahri,1,ES", "u2,Zed,2,jp"].join("\n");

  test("brings the participants with seeding and country", () => {
    const result = importFromBattlefyExport(csv, { title: "Mi Torneo" });

    expect(result.source).toBe("battlefy");
    expect(result.title).toBe("Mi Torneo");
    expect(result.participants).toEqual([
      expect.objectContaining({ externalId: "u1", name: "Ahri", seed: 1, country: "ES" }),
      expect.objectContaining({ externalId: "u2", name: "Zed", seed: 2, country: "JP" }),
    ]);
  });

  test("a file that went through Excel on Windows reads the same", () => {
    // An untreated `\r\n` leaves a `\r` stuck to the last field of each row, and the
    // country becomes "ES\r", which no longer validates as a two-letter code.
    const windows = csv.replace(/\n/g, "\r\n");
    expect(importFromBattlefyExport(windows).participants[0].country).toBe("ES");
  });

  test("headers are looked up by SYNONYMS, not by literal", () => {
    // Battlefy does not export the same headers between games or between versions
    // of the panel; tying to a literal leaves the import blank.
    const alt = ["Team Name,Player ID", "Team Rojo,t1"].join("\n");
    const result = importFromBattlefyExport(alt);
    expect(result.participants[0]).toMatchObject({ name: "Team Rojo", externalId: "t1" });
  });

  test("uppercase, spaces and underscores in the headers do not matter", () => {
    const messy = ["  USER_ID , In-Game Name ", "u9,Yone"].join("\n");
    expect(importFromBattlefyExport(messy).participants[0]).toMatchObject({
      externalId: "u9",
      name: "Yone",
    });
  });

  test("without an id column it WARNS that reimporting will duplicate", () => {
    // Matching by name is exactly what external identity exists to avoid.
    // It warns instead of failing: importing with a known limitation is worth more
    // than not importing.
    const result = importFromBattlefyExport(["name", "Ahri"].join("\n"));
    expect(result.participants[0].externalId).toBe("name:Ahri");
    expect(result.warnings.join(" ")).toMatch(/A rename will create a duplicate/);
  });

  test("a duplicate is ignored and it says on which row", () => {
    const dup = ["userID,name", "u1,Ahri", "u1,Ahri"].join("\n");
    const result = importFromBattlefyExport(dup);
    expect(result.participants).toHaveLength(1);
    expect(result.warnings.join(" ")).toMatch(/Row 3/);
  });

  test("without a name column it does NOT guess: it says which headers there were", () => {
    expect(() => importFromBattlefyExport(["foo,bar", "1,2"].join("\n"))).toThrow(/foo, bar/);
  });

  test("a country that is not a two-letter code is not made up", () => {
    const named = ["userID,name,country", "u1,Ahri,Japan"].join("\n");
    expect(importFromBattlefyExport(named).participants[0].country).toBeNull();
  });

  test("an empty or odd seed stays null, not 0", () => {
    // Seed 0 does not exist, and letting it through would sort that person first.
    const noSeed = ["userID,name,seed", "u1,Ahri,", "u2,Zed,-3"].join("\n");
    const result = importFromBattlefyExport(noSeed);
    expect(result.participants[0].seed).toBeNull();
    expect(result.participants[1].seed).toBeNull();
  });

  test("an empty file or one with only a header says so", () => {
    expect(() => importFromBattlefyExport("")).toThrow(ImportError);
    expect(() => importFromBattlefyExport("name,seed")).toThrow(/only a header/);
  });
});

describe("importing a JSON", () => {
  test("an array of teams with their roster", () => {
    const json = JSON.stringify([
      { _id: "t1", name: "Team Rojo", players: [{ _id: "p1", inGameName: "Ahri" }] },
    ]);
    const result = importFromBattlefyExport(json, { isTeamEvent: true });

    expect(result.isTeamEvent).toBe(true);
    expect(result.participants[0]).toMatchObject({ externalId: "t1", name: "Team Rojo" });
    expect(result.participants[0].members).toEqual([{ externalId: "p1", name: "Ahri" }]);
  });

  test("also valid wrapped in `teams` or in `participants`", () => {
    // Whoever downloads a file should not have to know which of the two
    // forms they got.
    for (const key of ["teams", "participants"]) {
      const json = JSON.stringify({ [key]: [{ _id: "x", name: "Solo" }] });
      expect(importFromBattlefyExport(json).participants).toHaveLength(1);
    }
  });

  test("a JSON that is not a recognizable list explains it", () => {
    expect(() => importFromBattlefyExport('{"foo":1}')).toThrow(/teams.*participants/s);
  });

  test("a broken JSON is not mistaken for a CSV", () => {
    expect(() => importFromBattlefyExport("[{roto")).toThrow(/cannot be read/);
  });
});

describe("the neutral model is respected", () => {
  test("Battlefy brings no bracket or prize pool, and says so by returning empty", () => {
    // The PARTICIPANTS export carries no sets. Kitsuden generates the bracket
    // with the imported seeding, just like with start.gg.
    const result = importFromBattlefyExport(["userID,name", "u1,Ahri"].join("\n"));
    expect(result.sets).toEqual([]);
    expect(result.prizePool).toBeNull();
  });

  test("the tournament id comes from the URL if they gave one", () => {
    const result = importFromBattlefyExport(["userID,name", "u1,Ahri"].join("\n"), {
      url: "https://battlefy.com/mi-org/mi-torneo/64f1a2b3c4d5e6f7a8b9c0d1/info",
    });
    expect(result.externalId).toBe("64f1a2b3c4d5e6f7a8b9c0d1");
  });
});
