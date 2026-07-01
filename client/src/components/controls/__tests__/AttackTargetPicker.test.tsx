import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AttackTarget, GameState } from "../../../adapter/types.ts";
import { useGameStore } from "../../../stores/gameStore.ts";
import { useMultiplayerStore } from "../../../stores/multiplayerStore.ts";
import { AttackTargetPicker } from "../AttackTargetPicker.tsx";

vi.mock("framer-motion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("framer-motion")>();
  return {
    ...actual,
    AnimatePresence: ({ children }: { children: import("react").ReactNode }) => <>{children}</>,
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

function playerTarget(playerId: number): AttackTarget {
  return { type: "Player", data: playerId };
}

describe("AttackTargetPicker", () => {
  beforeEach(() => {
    useGameStore.setState({
      gameState: {
        seat_order: [0, 1, 2],
        format_config: { team_based: false },
        objects: {},
      } as unknown as GameState,
      gameMode: undefined,
    });
    useMultiplayerStore.setState({
      activePlayerId: null,
      playerNames: new Map(),
    });
  });

  afterEach(() => {
    cleanup();
    useGameStore.setState({ gameState: null, gameMode: undefined });
    useMultiplayerStore.setState({
      activePlayerId: null,
      playerNames: new Map(),
    });
  });

  it("offers only common targets in Attack All mode", () => {
    const onConfirm = vi.fn();

    render(
      <AttackTargetPicker
        validTargets={[playerTarget(1), playerTarget(2)]}
        validTargetsByAttacker={{
          "11": [playerTarget(2)],
          "12": [playerTarget(1), playerTarget(2)],
        }}
        selectedAttackers={[11, 12]}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );

    expect(screen.queryByRole("button", { name: /Opp 2/i })).not.toBeInTheDocument();

    const commonTargetButton = screen.getByRole("button", { name: /Opp 3/i });
    fireEvent.click(commonTargetButton);

    expect(onConfirm).toHaveBeenCalledWith([
      [11, playerTarget(2)],
      [12, playerTarget(2)],
    ]);
  });
});
