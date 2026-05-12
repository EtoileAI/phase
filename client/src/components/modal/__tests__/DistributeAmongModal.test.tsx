import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WaitingFor } from "../../../adapter/types.ts";
import { DistributeAmongModal } from "../DistributeAmongModal.tsx";

vi.mock("../../../hooks/useGameDispatch.ts", () => ({
  useGameDispatch: () => vi.fn(),
}));

type DistributeAmong = Extract<WaitingFor, { type: "DistributeAmong" }>;

function distributeAmongData(
  unit: DistributeAmong["data"]["unit"],
): DistributeAmong["data"] {
  return {
    player: 0,
    total: 2,
    targets: [{ Object: 101 }, { Object: 102 }],
    unit,
  };
}

afterEach(() => {
  cleanup();
});

describe("DistributeAmongModal", () => {
  it("formats canonical counter names for display", () => {
    const { rerender } = render(
      <DistributeAmongModal data={distributeAmongData({ type: "Counters", data: "P1P1" })} />,
    );

    expect(screen.getByText("Distribute 2 +1/+1 counter")).toBeInTheDocument();
    expect(
      screen.getByText("Assign at least 1 +1/+1 counter to each target. Remaining: 2"),
    ).toBeInTheDocument();

    rerender(
      <DistributeAmongModal data={distributeAmongData({ type: "Counters", data: "M1M1" })} />,
    );

    expect(screen.getByText("Distribute 2 -1/-1 counter")).toBeInTheDocument();
  });

  it("leaves generic counter names readable", () => {
    render(<DistributeAmongModal data={distributeAmongData({ type: "Counters", data: "lore" })} />);

    expect(screen.getByText("Distribute 2 lore counter")).toBeInTheDocument();
  });
});
