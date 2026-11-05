/**
 * Compatibility and meta support tests for Tier Lists
 * ============================================================================
 *
 * Verifies that meta metadata support (card games, tournaments, statistics)
 * is 100% compatible with the existing character and gacha models .
 */

import { describe, expect, it } from "vitest";

import {
  calculatePlacementsFromStats,
  createTierList,
  diffTierLists,
  place,
  syncWithCatalog,
  validateTierList,
  DEFAULT_TIERS,
  type Tier,
  type TierItem,
  type TierList,
} from "../../kons/kon-tierlist/tierlist.engine";

describe("kon-tierlist: compatibility of character tier lists and Meta support (card games)", () => {
  const cardTiers: Tier[] = [
    { id: "t0", label: "Tier 0", color: "#ff4d4d" },
    { id: "t1", label: "Tier 1", color: "#ff9933" },
    { id: "t2", label: "Tier 2", color: "#ffcc00" },
    { id: "t3", label: "Tier 3", color: "#33ccff" },
    { id: "rogue", label: "Rogue", color: "#999999" },
  ];

  it("keeps compatibility with traditional items without meta ", () => {
    const plainItems: TierItem[] = [
      {
        id: "wavwal",
        label: "Wavwal",
        imageUrl: "http://localhost:3000/wavwal.webp",
        sourceRef: "wavwal",
      },
      {
        id: "geoclaw",
        label: "Geoclaw",
        imageUrl: "http://localhost:3000/geoclaw.webp",
        sourceRef: "geoclaw",
      },
    ];

    const list = createTierList(DEFAULT_TIERS, plainItems);
    expect(list.items).toHaveLength(2);
    expect(list.items[0].meta).toBeUndefined();

    const placed = place(list, "wavwal", "s");
    expect(placed.placement["wavwal"]).toBe("s");
    expect(validateTierList(placed)).toHaveLength(0);
  });

  it("accepts items with card game meta metadata (share, winRate, composition, tournaments)", () => {
    const cardItems: TierItem[] = [
      {
        id: "linlin",
        label: "Charlotte Linlin",
        imageUrl: "http://localhost:3000/linlin.webp",
        sourceRef: "linlin",
        meta: {
          share: 16.54,
          winRate: 54.2,
          rank: 1,
          delta: 2,
          score: 107,
          source: "Limitless Tournament Platform",
          matches: 240,
          composition: [
            { card: "Charlotte Katakuri", copies: 4, card_id: "OP03-123" },
            { card: "Sweet 3 Generals", copies: 2, card_id: "OP17-114" },
          ],
        },
      },
      {
        id: "doflamingo",
        label: "Donquixote Doflamingo",
        imageUrl: "http://localhost:3000/dofla.webp",
        sourceRef: "dofla",
        meta: {
          share: 9.3,
          winRate: 51.0,
          rank: 2,
          delta: -1,
          score: 65,
        },
      },
    ];

    const list = createTierList(cardTiers, cardItems);
    expect(validateTierList(list)).toHaveLength(0);
    expect(list.items[0].meta?.share).toBe(16.54);
    expect(list.items[0].meta?.composition).toHaveLength(2);
  });

  it("computes automatic placements by share (%) according to competitive thresholds", () => {
    const cardItems: TierItem[] = [
      { id: "m1", label: "Mazo Dominante", imageUrl: null, meta: { share: 55.0 } },
      { id: "m2", label: "Mazo Tier 1", imageUrl: null, meta: { share: 18.2 } },
      { id: "m3", label: "Mazo Tier 2", imageUrl: null, meta: { share: 11.5 } },
      { id: "m4", label: "Mazo Tier 3", imageUrl: null, meta: { share: 4.8 } },
      { id: "m5", label: "Mazo Rogue", imageUrl: null, meta: { share: 1.2 } },
      { id: "m6", label: "Mazo Sin Stats", imageUrl: null },
    ];

    const thresholds = [
      { tierId: "t0", minShare: 50.0 },
      { tierId: "t1", minShare: 15.0 },
      { tierId: "t2", minShare: 8.0 },
      { tierId: "t3", minShare: 3.0 },
      { tierId: "rogue", minShare: 0.0 },
    ];

    const placement = calculatePlacementsFromStats(cardItems, thresholds, "share");

    expect(placement["m1"]).toBe("t0");
    expect(placement["m2"]).toBe("t1");
    expect(placement["m3"]).toBe("t2");
    expect(placement["m4"]).toBe("t3");
    expect(placement["m5"]).toBe("rogue");
    expect(placement["m6"]).toBeUndefined(); // Without stats it stays in the unranked pool
  });

  it("syncWithCatalog preserves and updates the meta metadata when syncing", () => {
    const initialList: TierList = {
      tiers: cardTiers,
      items: [
        {
          id: "m1",
          label: "Arquetipo A",
          imageUrl: null,
          meta: { share: 10.0, rank: 3 },
        },
      ],
      placement: { m1: "t2" },
    };

    const newCatalog: TierItem[] = [
      {
        id: "m1",
        label: "Arquetipo A (Nuevo Nombre)",
        imageUrl: "http://localhost:3000/nuevo.webp",
        meta: { share: 17.5, rank: 1 }, // The deck rose to Tier 1 in the new tournament
      },
      {
        id: "m2",
        label: "Arquetipo B",
        imageUrl: null,
        meta: { share: 5.0 },
      },
    ];

    const synced = syncWithCatalog(initialList, newCatalog);

    expect(synced.items).toHaveLength(2);
    const m1 = synced.items.find((i) => i.id === "m1");
    expect(m1?.label).toBe("Arquetipo A (Nuevo Nombre)");
    expect(m1?.imageUrl).toBe("http://localhost:3000/nuevo.webp");
    expect(m1?.meta?.share).toBe(17.5);
    expect(m1?.meta?.rank).toBe(1);
    // The previous placement is respected
    expect(synced.placement["m1"]).toBe("t2");
    // The new item m2 is left unplaced (unranked)
    expect(synced.placement["m2"]).toBeUndefined();
  });

  it("diffTierLists detects promotions and demotions in lists with meta", () => {
    const before: TierList = {
      tiers: cardTiers,
      items: [
        { id: "m1", label: "Mazo A", imageUrl: null, meta: { share: 10.0 } },
        { id: "m2", label: "Mazo B", imageUrl: null, meta: { share: 20.0 } },
      ],
      placement: { m1: "t2", m2: "t1" },
    };

    const after: TierList = {
      tiers: cardTiers,
      items: [
        { id: "m1", label: "Mazo A", imageUrl: null, meta: { share: 22.0 } },
        { id: "m2", label: "Mazo B", imageUrl: null, meta: { share: 7.0 } },
      ],
      placement: { m1: "t1", m2: "t2" }, // m1 was promoted to t1, m2 was demoted to t2
    };

    const diff = diffTierLists(before, after);

    expect(diff.promoted).toHaveLength(1);
    expect(diff.promoted[0].item.id).toBe("m1");
    expect(diff.demoted).toHaveLength(1);
    expect(diff.demoted[0].item.id).toBe("m2");
  });
});
