import { describe, expect, it } from "vitest";

import type { AttackTarget, GameObject, GameState, ObjectId } from "../../adapter/types";
import {
  buildAttacks,
  evenSplit,
  getValidAttackTargetsForAttacker,
  groupAttackers,
  selectedAttackersNeedTargetPicker,
} from "../combat";

function playerTarget(playerId: number): AttackTarget {
  return { type: "Player", data: playerId };
}

function declareAttackersState(
  validAttackTargetsByAttacker: Record<string, AttackTarget[]>,
): GameState {
  return {
    waiting_for: {
      type: "DeclareAttackers",
      data: {
        player: 0,
        valid_attacker_ids: [11, 12],
        valid_attack_targets: [playerTarget(1), playerTarget(2)],
        valid_attack_targets_by_attacker: validAttackTargetsByAttacker,
      },
    },
    players: [
      { id: 0, life: 20, poison_counters: 0, mana_pool: { mana: [] }, library: [], hand: [], graveyard: [], has_drawn_this_turn: false, lands_played_this_turn: 0, turns_taken: 0 },
      { id: 1, life: 20, poison_counters: 0, mana_pool: { mana: [] }, library: [], hand: [], graveyard: [], has_drawn_this_turn: false, lands_played_this_turn: 0, turns_taken: 0 },
      { id: 2, life: 20, poison_counters: 0, mana_pool: { mana: [] }, library: [], hand: [], graveyard: [], has_drawn_this_turn: false, lands_played_this_turn: 0, turns_taken: 0 },
    ],
    seat_order: [0, 1, 2],
  } as unknown as GameState;
}

function makeObject(overrides: Partial<GameObject> & { id: ObjectId }): GameObject {
  return {
    card_id: 100,
    owner: 0,
    controller: 0,
    zone: "Battlefield",
    tapped: false,
    face_down: false,
    flipped: false,
    transformed: false,
    damage_marked: 0,
    dealt_deathtouch_damage: false,
    attached_to: null,
    attachments: [],
    counters: {},
    name: "Goblin",
    power: 1,
    toughness: 1,
    loyalty: null,
    card_types: { supertypes: [], core_types: ["Creature"], subtypes: [] },
    mana_cost: { type: "NoCost" },
    keywords: [],
    abilities: [],
    trigger_definitions: [],
    replacement_definitions: [],
    static_definitions: [],
    color: ["Red"],
    base_power: 1,
    base_toughness: 1,
    base_keywords: [],
    base_color: ["Red"],
    timestamp: 1,
    entered_battlefield_turn: 1,
    ...overrides,
  };
}

function makeState(
  objects: GameObject[],
  ringBearer?: Record<string, ObjectId | null>,
): GameState {
  const map: Record<string, GameObject> = {};
  for (const obj of objects) map[obj.id] = obj;
  return { objects: map, ring_bearer: ringBearer } as unknown as GameState;
}

describe("combat utils", () => {
  it("builds per-attacker defaults from engine legality instead of seat order", () => {
    const state = declareAttackersState({
      "11": [playerTarget(2)],
      "12": [playerTarget(1)],
    });

    expect(buildAttacks([11, 12], state, 0)).toEqual([
      [11, playerTarget(2)],
      [12, playerTarget(1)],
    ]);
  });

  it("does not force the target picker when each attacker has only one legal target", () => {
    const attackers: ObjectId[] = [11, 12];
    const state = declareAttackersState({
      "11": [playerTarget(2)],
      "12": [playerTarget(1)],
    });

    expect(selectedAttackersNeedTargetPicker(state, attackers)).toBe(false);
  });

  it("forces the target picker when an attacker has multiple legal targets", () => {
    const state = declareAttackersState({
      "11": [playerTarget(1), playerTarget(2)],
      "12": [playerTarget(1)],
    });

    expect(getValidAttackTargetsForAttacker(state, 11)).toEqual([
      playerTarget(1),
      playerTarget(2),
    ]);
    expect(selectedAttackersNeedTargetPicker(state, [11, 12])).toBe(true);
  });

  it("treats an attacker missing from the per-attacker map as having no legal targets", () => {
    const state = declareAttackersState({
      "12": [playerTarget(1)],
    });

    expect(getValidAttackTargetsForAttacker(state, 11)).toEqual([]);
  });
});

describe("evenSplit", () => {
  it("distributes evenly with no remainder", () => {
    expect(evenSplit(30, 3)).toEqual([10, 10, 10]);
  });

  it("front-loads the remainder onto the earliest buckets", () => {
    expect(evenSplit(31, 3)).toEqual([11, 10, 10]);
    expect(evenSplit(2, 5)).toEqual([1, 1, 0, 0, 0]);
  });

  it("returns all zeros for a non-positive count", () => {
    expect(evenSplit(0, 3)).toEqual([0, 0, 0]);
    expect(evenSplit(-4, 2)).toEqual([0, 0]);
  });

  it("returns an empty array when there are no buckets", () => {
    expect(evenSplit(5, 0)).toEqual([]);
    expect(evenSplit(5, -1)).toEqual([]);
  });

  it("always sums back to the (clamped) count and has the right length", () => {
    for (const [count, buckets] of [[31, 3], [7, 7], [1, 4], [100, 6]] as const) {
      const split = evenSplit(count, buckets);
      expect(split).toHaveLength(buckets);
      expect(split.reduce((a, b) => a + b, 0)).toBe(count);
    }
  });
});

describe("groupAttackers", () => {
  it("groups identical creatures into one stack and distinct ones separately", () => {
    const state = makeState([
      makeObject({ id: 200, name: "Elf", power: 2, toughness: 2 }),
      makeObject({ id: 103 }),
      makeObject({ id: 101 }),
      makeObject({ id: 102 }),
    ]);

    const stacks = groupAttackers([200, 103, 101, 102], state);

    expect(stacks).toHaveLength(2);
    expect(stacks[0]).toMatchObject({ name: "Goblin", count: 3, ids: [101, 102, 103] });
    expect(stacks[1]).toMatchObject({ name: "Elf", count: 1, ids: [200] });
    expect(stacks[0].key).toBe("101");
    expect(stacks[0].representative?.id).toBe(101);
  });

  it("sorts member ids ascending regardless of input order", () => {
    const state = makeState([
      makeObject({ id: 5 }),
      makeObject({ id: 1 }),
      makeObject({ id: 9 }),
    ]);
    const [stack] = groupAttackers([9, 1, 5], state);
    expect(stack.ids).toEqual([1, 5, 9]);
  });

  it("keeps the Ring-bearer as its own stack (CR 701.54)", () => {
    const state = makeState(
      [makeObject({ id: 101 }), makeObject({ id: 102 }), makeObject({ id: 103 })],
      { "0": 102 },
    );

    const stacks = groupAttackers([101, 102, 103], state);

    expect(stacks).toHaveLength(2);
    expect(stacks[0]).toMatchObject({ count: 2, ids: [101, 103] });
    expect(stacks[1]).toMatchObject({ count: 1, ids: [102] });
  });

  it("falls back to singleton stacks (sorted) when state is missing", () => {
    const stacks = groupAttackers([3, 1, 2], null);
    expect(stacks.map((s) => s.ids)).toEqual([[1], [2], [3]]);
    expect(stacks.every((s) => s.count === 1 && s.representative === null)).toBe(true);
  });
});
