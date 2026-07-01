import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";

import type { AttackTarget, GameObject, GameState, ObjectId } from "../../../adapter/types.ts";
import { AttackTargetPicker } from "../AttackTargetPicker.tsx";
import { useGameStore } from "../../../stores/gameStore.ts";
import { useMultiplayerStore } from "../../../stores/multiplayerStore.ts";

vi.mock("framer-motion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("framer-motion")>();
  return {
    ...actual,
    motion: {
      div: ({ children, ...props }: import("react").HTMLAttributes<HTMLDivElement>) => (
        <div {...props}>{children}</div>
      ),
      button: ({ children, ...props }: import("react").ButtonHTMLAttributes<HTMLButtonElement>) => (
        <button {...props}>{children}</button>
      ),
    },
    useReducedMotion: () => true,
  };
});

const P1: AttackTarget = { type: "Player", data: 1 };
const P2: AttackTarget = { type: "Player", data: 2 };
const TARGETS: AttackTarget[] = [P1, P2];
const ATTACKERS: ObjectId[] = [101, 102, 103];

function makeObject(id: ObjectId, name: string): GameObject {
  return {
    id,
    card_id: 1,
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
    name,
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
  };
}

function makeState(): GameState {
  return {
    seat_order: [0, 1, 2],
    format_config: { team_based: false },
    objects: {
      101: makeObject(101, "Goblin"),
      102: makeObject(102, "Goblin"),
      103: makeObject(103, "Goblin"),
    },
  } as unknown as GameState;
}

function renderPicker(overrides?: Partial<ComponentProps<typeof AttackTargetPicker>>) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <AttackTargetPicker
      validTargets={TARGETS}
      selectedAttackers={ATTACKERS}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { onConfirm, onCancel };
}

function enterDistribute() {
  fireEvent.click(screen.getByRole("button", { name: /distribute/i }));
}

function getAssignOneButtons() {
  return screen.getAllByRole("button", { name: /assignOne/i });
}

function getAssignAllButtons() {
  return screen.getAllByRole("button", { name: /assignAllHere/i });
}

function getRemoveOneButtons() {
  return screen.getAllByRole("button", { name: /removeOne/i });
}

describe("AttackTargetPicker", () => {
  beforeEach(() => {
    useMultiplayerStore.setState({ activePlayerId: 0, playerNames: new Map() });
    useGameStore.setState({ gameState: makeState(), gameMode: undefined });
  });

  afterEach(() => {
    cleanup();
    useGameStore.setState({ gameState: null, gameMode: undefined });
    useMultiplayerStore.setState({ activePlayerId: null, playerNames: new Map() });
  });

  it("keeps Attack All mode working (one click sends every attacker to a target)", () => {
    const { onConfirm } = renderPicker();
    fireEvent.click(screen.getByRole("button", { name: /Attack Opp 2 with 3 creatures/ }));
    expect(onConfirm).toHaveBeenCalledWith([
      [101, P1],
      [102, P1],
      [103, P1],
    ]);
  });

  it("offers only common targets in Attack All mode when legality differs by attacker", () => {
    const { onConfirm } = renderPicker({
      selectedAttackers: [101, 102],
      validTargetsByAttacker: {
        "101": [P2],
        "102": [P1, P2],
      },
    });

    expect(screen.queryByRole("button", { name: /Opp 2/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Attack Opp 3 with 2 creatures/ }));
    expect(onConfirm).toHaveBeenCalledWith([
      [101, P2],
      [102, P2],
    ]);
  });

  it("disables Confirm until Unassigned is empty, then even-splits across targets", () => {
    const { onConfirm } = renderPicker();
    enterDistribute();

    const gated = screen.getByRole("button", { name: /assignRemaining/i });
    expect(gated).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: /evenSplitAll/i }));

    const confirm = screen.getByRole("button", { name: /confirmDistribute/i });
    expect(confirm).not.toBeDisabled();
    fireEvent.click(confirm);

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith([
      [101, P1],
      [102, P1],
      [103, P2],
    ]);
  });

  it("steppers claim the lowest-id unassigned member deterministically", () => {
    const { onConfirm } = renderPicker();
    enterDistribute();

    fireEvent.click(getAssignOneButtons()[0]);
    fireEvent.click(getAssignOneButtons()[0]);
    fireEvent.click(getAssignOneButtons()[1]);

    fireEvent.click(screen.getByRole("button", { name: /confirmDistribute/i }));
    expect(onConfirm).toHaveBeenCalledWith([
      [101, P1],
      [102, P1],
      [103, P2],
    ]);
  });

  it("'-1' releases the highest-id member back to Unassigned", () => {
    const { onConfirm } = renderPicker();
    enterDistribute();

    fireEvent.click(getAssignAllButtons()[0]);
    fireEvent.click(getRemoveOneButtons()[0]);
    fireEvent.click(getAssignOneButtons()[1]);

    fireEvent.click(screen.getByRole("button", { name: /confirmDistribute/i }));
    expect(onConfirm).toHaveBeenCalledWith([
      [101, P1],
      [102, P1],
      [103, P2],
    ]);
  });

  it("'send all to target' assigns the whole stack at once", () => {
    const { onConfirm } = renderPicker();
    enterDistribute();

    fireEvent.click(getAssignAllButtons()[0]);
    fireEvent.click(screen.getByRole("button", { name: /confirmDistribute/i }));

    expect(onConfirm).toHaveBeenCalledWith([
      [101, P1],
      [102, P1],
      [103, P1],
    ]);
  });
});
