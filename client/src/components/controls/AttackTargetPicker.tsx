import { useCallback, useMemo, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { Trans, useTranslation } from "react-i18next";

import type { AttackTarget, GameObject, ObjectId, PlayerId } from "../../adapter/types.ts";
import { getSeatColor } from "../../hooks/useSeatColor.ts";
import { useInspectHoverProps } from "../../hooks/useInspectHoverProps.ts";
import { useGameStore } from "../../stores/gameStore.ts";
import { getPlayerDisplayName } from "../../stores/multiplayerStore.ts";
import { usePlayerId } from "../../hooks/usePlayerId.ts";
import { formatCounterType } from "../../viewmodel/cardProps.ts";
import { type AttackerStack, evenSplit, groupAttackers } from "../../utils/combat.ts";
import { gameButtonClass } from "../ui/buttonStyles.ts";
import { PeekTab } from "../modal/DialogShell.tsx";

/** Internal assignment map: every attacker maps to its chosen target, or `null`
 * while it sits in the Unassigned bucket. */
type AssignmentMap = Map<ObjectId, AttackTarget | null>;

interface TargetConstrainedStack extends AttackerStack {
  legalTargets: AttackTarget[];
}

interface AttackTargetPickerProps {
  validTargets: AttackTarget[];
  validTargetsByAttacker?: Record<string, AttackTarget[]>;
  selectedAttackers: ObjectId[];
  onConfirm: (attacks: [ObjectId, AttackTarget][]) => void;
  onCancel: () => void;
}

/**
 * Attack-target selection for multiplayer / multi-defender games.
 *
 * Two modes:
 * - "all" (default): pick one target, all attackers go there.
 * - "distribute": a bucket-per-target board where identical attackers are
 *   grouped into stacks and spread across legal targets plus an Unassigned
 *   bucket. Stacks are split further when otherwise-identical attackers have
 *   different legal target sets, so the frontend never invites an illegal
 *   per-attacker assignment.
 *
 * Frontend display layer only: it merely arranges the attacker→target choices
 * the player makes and hands the flat array to the engine, which validates it.
 */
export function AttackTargetPicker({
  validTargets,
  validTargetsByAttacker,
  selectedAttackers,
  onConfirm,
  onCancel,
}: AttackTargetPickerProps) {
  const { t } = useTranslation("game");
  const [mode, setMode] = useState<"all" | "distribute">("all");
  const [peeked, setPeeked] = useState(false);
  const [assignments, setAssignments] = useState<AssignmentMap>(
    () => new Map(selectedAttackers.map((id) => [id, null] as const)),
  );
  const [expandedStack, setExpandedStack] = useState<string | null>(null);
  const shouldReduceMotion = useReducedMotion();

  const gameState = useGameStore((s) => s.gameState);
  const myId = usePlayerId();
  const hoverProps = useInspectHoverProps();
  const seatOrder = gameState?.seat_order;
  const teamBased = gameState?.format_config?.team_based ?? false;

  const targetsForCreature = useCallback(
    (creatureId: ObjectId): AttackTarget[] =>
      validTargetsByAttacker?.[String(creatureId)] ?? validTargets,
    [validTargetsByAttacker, validTargets],
  );

  const sortedTargets = useMemo(() => {
    if (!seatOrder) return validTargets;
    return [...validTargets].sort((a, b) => {
      const aIdx = a.type === "Player" ? seatOrder.indexOf(a.data) : Infinity;
      const bIdx = b.type === "Player" ? seatOrder.indexOf(b.data) : Infinity;
      if (aIdx !== bIdx) return aIdx - bIdx;
      return Number(a.data) - Number(b.data);
    });
  }, [validTargets, seatOrder]);

  const commonTargets = useMemo(
    () => sortedTargets.filter((target) =>
      selectedAttackers.every((id) =>
        targetsForCreature(id).some((candidate) => sameAttackTarget(candidate, target))),
    ),
    [selectedAttackers, sortedTargets, targetsForCreature],
  );

  const stacks = useMemo<TargetConstrainedStack[]>(() => {
    const grouped = groupAttackers(selectedAttackers, gameState);
    const expanded: TargetConstrainedStack[] = [];

    for (const stack of grouped) {
      const bySignature = new Map<string, { ids: ObjectId[]; legalTargets: AttackTarget[] }>();

      for (const id of stack.ids) {
        const legalTargets = targetsForCreature(id);
        const signature = targetSignature(legalTargets);
        const existing = bySignature.get(signature);
        if (existing) {
          existing.ids.push(id);
        } else {
          bySignature.set(signature, { ids: [id], legalTargets });
        }
      }

      for (const [signature, entry] of bySignature) {
        const ids = [...entry.ids].sort((a, b) => a - b);
        expanded.push({
          ...stack,
          key: `${stack.key}:${signature || "none"}`,
          ids,
          count: ids.length,
          representative: gameState?.objects[ids[0]] ?? stack.representative,
          legalTargets: entry.legalTargets,
        });
      }
    }

    return expanded.sort((a, b) => a.ids[0] - b.ids[0]);
  }, [gameState, selectedAttackers, targetsForCreature]);

  const unassignedTotal = useMemo(
    () => selectedAttackers.reduce((n, id) => n + (assignments.get(id) == null ? 1 : 0), 0),
    [assignments, selectedAttackers],
  );

  function getTargetLabel(target: AttackTarget): string {
    if (target.type === "Player") {
      return getPlayerLabel(t, target.data, myId, teamBased);
    }
    const obj = gameState?.objects[target.data];
    return obj?.name ?? t("attackTargetPicker.objectFallback", { id: target.data });
  }

  function getTargetSeatColor(target: AttackTarget): string | undefined {
    if (target.type === "Player") {
      return getSeatColor(target.data, seatOrder);
    }
    const obj = gameState?.objects[target.data];
    return obj ? getSeatColor(obj.controller, seatOrder) : undefined;
  }

  function handleAttackAll(target: AttackTarget) {
    onConfirm(selectedAttackers.map((id) => [id, target]));
  }

  function mutate(fn: (next: AssignmentMap) => void) {
    setAssignments((prev) => {
      const next = new Map(prev);
      fn(next);
      return next;
    });
  }

  function incOnTarget(stack: TargetConstrainedStack, target: AttackTarget) {
    mutate((next) => {
      const id = lowestUnassigned(stack, next);
      if (id != null) next.set(id, target);
    });
  }

  function decFromTarget(stack: TargetConstrainedStack, target: AttackTarget) {
    mutate((next) => {
      const id = highestOnTarget(stack, target, next);
      if (id != null) next.set(id, null);
    });
  }

  function allOfStackToTarget(stack: TargetConstrainedStack, target: AttackTarget) {
    mutate((next) => {
      for (const id of stack.ids) next.set(id, target);
    });
  }

  function spreadStack(stack: TargetConstrainedStack) {
    mutate((next) => spreadStackEvenly(next, stack, stack.legalTargets));
  }

  function spreadAll() {
    mutate((next) => {
      for (const stack of stacks) spreadStackEvenly(next, stack, stack.legalTargets);
    });
  }

  function allStacksToTarget(target: AttackTarget) {
    mutate((next) => {
      for (const id of selectedAttackers) next.set(id, target);
    });
  }

  function resetAll() {
    mutate((next) => {
      for (const id of selectedAttackers) next.set(id, null);
    });
  }

  function countOnTarget(stack: TargetConstrainedStack, target: AttackTarget): number {
    const key = attackTargetKey(target);
    return stack.ids.reduce((n, id) => {
      const t = assignments.get(id);
      return n + (t && attackTargetKey(t) === key ? 1 : 0);
    }, 0);
  }

  function countUnassigned(stack: TargetConstrainedStack): number {
    return stack.ids.reduce((n, id) => n + (assignments.get(id) == null ? 1 : 0), 0);
  }

  function handleDistributeConfirm() {
    const attacks = selectedAttackers.flatMap((id): [ObjectId, AttackTarget][] => {
      const target = assignments.get(id);
      return target ? [[id, target]] : [];
    });
    onConfirm(attacks);
  }

  const slideTransform = peeked
    ? { x: "calc(100vw - 32px)" }
    : { x: 0 };

  const sidePadding = mode === "all" ? "px-8" : "px-4 sm:px-6";

  return (
    <>
      <motion.div
        className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-3"
        style={{ pointerEvents: peeked ? "none" : undefined }}
        animate={slideTransform}
        transition={
          shouldReduceMotion
            ? { duration: 0 }
            : { type: "spring", stiffness: 320, damping: 32 }
        }
      >
        <div
          className={`relative w-full ${mode === "all" ? "max-w-[420px]" : "max-w-[760px]"}`}
        >
          <div className="flex max-h-[85vh] flex-col overflow-hidden rounded-xl border border-gray-600 bg-gray-900/95 shadow-2xl backdrop-blur-sm">
            <div className={`shrink-0 pt-5 ${sidePadding}`}>
              <h3 className="mb-4 text-center text-lg font-bold text-gray-100">
                {t("attackTargetPicker.heading")}
              </h3>

              <div className="flex justify-center gap-2">
                <button
                  onClick={() => setMode("all")}
                  className={gameButtonClass({
                    tone: mode === "all" ? "blue" : "slate",
                    size: "sm",
                  })}
                >
                  {t("attackTargetPicker.attackAll")}
                </button>
                <button
                  onClick={() => setMode("distribute")}
                  className={gameButtonClass({
                    tone: mode === "distribute" ? "blue" : "slate",
                    size: "sm",
                  })}
                >
                  {t("attackTargetPicker.distribute")}
                </button>
              </div>
            </div>

            <div className={`min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain thin-scrollbar pb-2 pt-4 ${sidePadding}`}>
              {mode === "all" ? (
                <div className="flex flex-col gap-2">
                  {commonTargets.map((target) => {
                    const color = getTargetSeatColor(target);
                    return (
                      <button
                        key={attackTargetKey(target)}
                        onClick={() => handleAttackAll(target)}
                        className={gameButtonClass({ tone: "red", size: "md" })}
                      >
                        <Trans
                          t={t}
                          i18nKey="attackTargetPicker.attackWith"
                          count={selectedAttackers.length}
                          values={{ label: getTargetLabel(target), count: selectedAttackers.length }}
                          components={{
                            name: <span className="mx-1 font-bold" style={color ? { color } : undefined} />,
                          }}
                        />
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className={`text-xs font-medium ${unassignedTotal > 0 ? "text-amber-300" : "text-emerald-300"}`}>
                      {unassignedTotal > 0
                        ? t("attackTargetPicker.unassignedRemaining", { count: unassignedTotal })
                        : t("attackTargetPicker.allAssigned")}
                    </p>
                    <div className="flex flex-wrap gap-1.5">
                      <button
                        onClick={spreadAll}
                        disabled={sortedTargets.length === 0}
                        className={gameButtonClass({ tone: "indigo", size: "xs", disabled: sortedTargets.length === 0 })}
                      >
                        {t("attackTargetPicker.evenSplitAll")}
                      </button>
                      <button
                        onClick={resetAll}
                        disabled={unassignedTotal === selectedAttackers.length}
                        className={gameButtonClass({ tone: "slate", size: "xs", disabled: unassignedTotal === selectedAttackers.length })}
                      >
                        {t("attackTargetPicker.resetAssignments")}
                      </button>
                    </div>
                  </div>

                  <div className="hidden overflow-x-auto overscroll-x-contain thin-scrollbar md:block">
                    <table className="w-full border-separate border-spacing-0 text-sm">
                      <thead>
                        <tr>
                          <th className="sticky left-0 z-10 bg-gray-900 px-2 py-1.5 text-left text-xs font-semibold text-gray-400">
                            {t("attackTargetPicker.attackersColumn")}
                          </th>
                          <th className="px-2 py-1.5 text-center text-xs font-semibold text-gray-400">
                            {t("attackTargetPicker.unassigned")}
                          </th>
                          {sortedTargets.map((target) => {
                            const color = getTargetSeatColor(target);
                            const globalTarget = commonTargets.some((candidate) =>
                              sameAttackTarget(candidate, target));
                            return (
                              <th key={attackTargetKey(target)} className="px-2 py-1.5 text-center align-top">
                                <div className="flex flex-col items-center gap-1">
                                  <span
                                    className="inline-flex items-center gap-1 text-xs font-semibold"
                                    style={color ? { color } : undefined}
                                  >
                                    <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: color ?? "#6b7280" }} />
                                    <span className="max-w-[7rem] truncate">{getTargetLabel(target)}</span>
                                  </span>
                                  {globalTarget && (
                                    <button
                                      type="button"
                                      onClick={() => allStacksToTarget(target)}
                                      className="rounded border border-gray-600 px-1.5 py-0.5 text-[10px] font-medium text-gray-300 hover:border-gray-400 hover:bg-white/10"
                                    >
                                      {t("attackTargetPicker.allHere")}
                                    </button>
                                  )}
                                </div>
                              </th>
                            );
                          })}
                        </tr>
                      </thead>
                      <tbody>
                        {stacks.map((stack) => {
                          const unassigned = countUnassigned(stack);
                          return (
                            <tr key={stack.key} className="border-t border-white/5">
                              <td className="sticky left-0 z-10 bg-gray-900 px-2 py-1.5">
                                <div className="flex items-center gap-2">
                                  <StackLabel stack={stack} t={t} hoverProps={hoverProps} />
                                  <button
                                    type="button"
                                    onClick={() => spreadStack(stack)}
                                    disabled={stack.legalTargets.length === 0}
                                    title={t("attackTargetPicker.spreadEvenly")}
                                    className="ml-auto shrink-0 rounded border border-gray-600 px-1.5 py-0.5 text-[10px] font-medium text-gray-300 hover:border-gray-400 hover:bg-white/10 disabled:opacity-30"
                                  >
                                    {t("attackTargetPicker.spread")}
                                  </button>
                                </div>
                              </td>
                              <td className="px-2 py-1.5 text-center">
                                <span
                                  className={`inline-block min-w-[1.5rem] rounded px-1.5 py-0.5 text-sm font-semibold tabular-nums ${
                                    unassigned > 0 ? "bg-amber-900/60 text-amber-100" : "text-gray-600"
                                  }`}
                                >
                                  {unassigned}
                                </span>
                              </td>
                              {sortedTargets.map((target) => {
                                const count = countOnTarget(stack, target);
                                const label = getTargetLabel(target);
                                const legalHere = stackSupportsTarget(stack, target);
                                return (
                                  <td key={attackTargetKey(target)} className="px-2 py-1.5">
                                    {legalHere ? (
                                      <StepperCell
                                        count={count}
                                        color={getTargetSeatColor(target)}
                                        canDec={count > 0}
                                        canInc={unassigned > 0}
                                        onDec={() => decFromTarget(stack, target)}
                                        onInc={() => incOnTarget(stack, target)}
                                        onAll={() => allOfStackToTarget(stack, target)}
                                        decTitle={t("attackTargetPicker.removeOne", { label })}
                                        incTitle={t("attackTargetPicker.assignOne", { label })}
                                        allTitle={t("attackTargetPicker.assignAllHere", { label })}
                                      />
                                    ) : (
                                      <div className="text-center text-xs text-gray-600">—</div>
                                    )}
                                  </td>
                                );
                              })}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div className="flex flex-col gap-2 md:hidden">
                    {stacks.map((stack) => {
                      const unassigned = countUnassigned(stack);
                      const expanded = expandedStack === stack.key;
                      return (
                        <div key={stack.key} className="overflow-hidden rounded-lg border border-gray-700">
                          <button
                            type="button"
                            onClick={() => setExpandedStack((cur) => (cur === stack.key ? null : stack.key))}
                            aria-expanded={expanded}
                            className="flex w-full items-center gap-2 px-2 py-2.5 text-left hover:bg-white/5"
                          >
                            <StackLabel stack={stack} t={t} hoverProps={hoverProps} />
                            <span
                              className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${
                                unassigned > 0 ? "bg-amber-900/70 text-amber-100" : "bg-emerald-900/70 text-emerald-100"
                              }`}
                            >
                              {unassigned > 0
                                ? t("attackTargetPicker.unassignedRemaining", { count: unassigned })
                                : t("attackTargetPicker.assignedBadge")}
                            </span>
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              viewBox="0 0 16 16"
                              fill="currentColor"
                              className={`h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform ${expanded ? "rotate-180" : ""}`}
                            >
                              <path fillRule="evenodd" d="M4.22 6.22a.75.75 0 0 1 1.06 0L8 8.94l2.72-2.72a.75.75 0 1 1 1.06 1.06l-3.25 3.25a.75.75 0 0 1-1.06 0L4.22 7.28a.75.75 0 0 1 0-1.06Z" clipRule="evenodd" />
                            </svg>
                          </button>
                          {expanded && (
                            <div className="flex flex-col gap-1.5 border-t border-white/10 px-2 py-2">
                              <button
                                type="button"
                                onClick={() => spreadStack(stack)}
                                disabled={stack.legalTargets.length === 0}
                                className={`self-start ${gameButtonClass({ tone: "indigo", size: "xs", disabled: stack.legalTargets.length === 0 })}`}
                              >
                                {t("attackTargetPicker.spreadEvenly")}
                              </button>
                              <div className="flex items-center justify-between gap-2 rounded px-1 py-1">
                                <span className="text-sm text-gray-400">{t("attackTargetPicker.unassigned")}</span>
                                <span
                                  className={`min-w-[1.5rem] rounded px-1.5 py-0.5 text-center text-sm font-semibold tabular-nums ${
                                    unassigned > 0 ? "bg-amber-900/60 text-amber-100" : "text-gray-600"
                                  }`}
                                >
                                  {unassigned}
                                </span>
                              </div>
                              {sortedTargets.map((target) => {
                                const color = getTargetSeatColor(target);
                                const count = countOnTarget(stack, target);
                                const label = getTargetLabel(target);
                                const legalHere = stackSupportsTarget(stack, target);
                                return (
                                  <div key={attackTargetKey(target)} className="flex items-center justify-between gap-2 rounded px-1 py-1">
                                    <span className="inline-flex min-w-0 items-center gap-1.5 text-sm" style={color ? { color } : undefined}>
                                      <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color ?? "#6b7280" }} />
                                      <span className="truncate">{label}</span>
                                    </span>
                                    {legalHere ? (
                                      <StepperCell
                                        count={count}
                                        color={color}
                                        canDec={count > 0}
                                        canInc={unassigned > 0}
                                        onDec={() => decFromTarget(stack, target)}
                                        onInc={() => incOnTarget(stack, target)}
                                        onAll={() => allOfStackToTarget(stack, target)}
                                        decTitle={t("attackTargetPicker.removeOne", { label })}
                                        incTitle={t("attackTargetPicker.assignOne", { label })}
                                        allTitle={t("attackTargetPicker.assignAllHere", { label })}
                                      />
                                    ) : (
                                      <div className="px-2 text-xs text-gray-600">—</div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            <div className={`shrink-0 border-t border-white/10 pb-5 pt-3 ${sidePadding}`}>
              {mode === "distribute" && (
                <button
                  onClick={handleDistributeConfirm}
                  disabled={unassignedTotal > 0}
                  className={`w-full ${gameButtonClass({ tone: "emerald", size: "md", disabled: unassignedTotal > 0 })}`}
                >
                  {unassignedTotal > 0
                    ? t("attackTargetPicker.assignRemaining", { count: unassignedTotal })
                    : t("attackTargetPicker.confirmDistribute", { count: selectedAttackers.length })}
                </button>
              )}
              <button
                onClick={onCancel}
                className={`w-full ${mode === "distribute" ? "mt-2" : ""} ${gameButtonClass({ tone: "slate", size: "sm" })}`}
              >
                {t("common:actions.cancel")}
              </button>
            </div>
          </div>
          <PeekTab onClick={() => setPeeked(true)} />
        </div>
      </motion.div>
      {peeked && <RestoreTab onClick={() => setPeeked(false)} />}
    </>
  );
}

function objectPtLabel(obj: GameObject | undefined): string | null {
  if (obj?.power == null || obj.toughness == null) return null;
  return `${obj.power}/${obj.toughness}`;
}

function objectCounterChips(obj: GameObject | undefined): Array<{ type: string; count: number }> {
  if (!obj) return [];
  return Object.entries(obj.counters)
    .filter((entry): entry is [string, number] => entry[1] != null && entry[1] > 0 && entry[0] !== "loyalty")
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, count]) => ({ type, count }));
}

function attackTargetKey(target: AttackTarget): string {
  return `${target.type}-${target.data}`;
}

function sameAttackTarget(a: AttackTarget, b: AttackTarget): boolean {
  return a.type === b.type && a.data === b.data;
}

function targetSignature(targets: AttackTarget[]): string {
  return [...targets]
    .map(attackTargetKey)
    .sort()
    .join("|");
}

function stackSupportsTarget(stack: TargetConstrainedStack, target: AttackTarget): boolean {
  return stack.legalTargets.some((candidate) => sameAttackTarget(candidate, target));
}

function RestoreTab({ onClick }: { onClick: () => void }) {
  const { t } = useTranslation("game");
  return (
    <motion.button
      type="button"
      onClick={onClick}
      aria-label={t("attackTargetPicker.restoreDialog")}
      title={t("attackTargetPicker.restoreDialogTitle")}
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{
        opacity: 1,
        scale: 1,
        boxShadow: [
          "0 18px 36px rgba(0,0,0,0.45), 0 0 0 1px rgba(34,211,238,0.2)",
          "0 18px 36px rgba(0,0,0,0.45), 0 0 28px rgba(34,211,238,0.55)",
          "0 18px 36px rgba(0,0,0,0.45), 0 0 0 1px rgba(34,211,238,0.2)",
        ],
      }}
      transition={{
        opacity: { delay: 0.1, duration: 0.2 },
        scale: { delay: 0.1, duration: 0.2 },
        boxShadow: { duration: 2.4, repeat: Infinity, ease: "easeInOut" },
      }}
      className="fixed right-3 top-1/2 z-[60] flex h-24 w-9 -translate-y-1/2 items-center justify-center rounded-2xl border border-cyan-400/40 bg-[#0b1020]/96 text-cyan-200 backdrop-blur-md transition-colors hover:bg-cyan-500/20 hover:text-white"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 20 20"
        fill="currentColor"
        className="h-6 w-6 rotate-180"
      >
        <path
          fillRule="evenodd"
          d="M7.22 4.22a.75.75 0 0 1 1.06 0l5.25 5.25a.75.75 0 0 1 0 1.06l-5.25 5.25a.75.75 0 1 1-1.06-1.06L11.94 10 7.22 5.28a.75.75 0 0 1 0-1.06Z"
          clipRule="evenodd"
        />
      </svg>
    </motion.button>
  );
}

function lowestUnassigned(stack: AttackerStack, map: AssignmentMap): ObjectId | null {
  for (const id of stack.ids) {
    if (map.get(id) == null) return id;
  }
  return null;
}

function highestOnTarget(stack: AttackerStack, target: AttackTarget, map: AssignmentMap): ObjectId | null {
  const key = attackTargetKey(target);
  for (let i = stack.ids.length - 1; i >= 0; i--) {
    const t = map.get(stack.ids[i]);
    if (t && attackTargetKey(t) === key) return stack.ids[i];
  }
  return null;
}

function spreadStackEvenly(map: AssignmentMap, stack: AttackerStack, targets: AttackTarget[]): void {
  if (targets.length === 0) return;
  const counts = evenSplit(stack.count, targets.length);
  let member = 0;
  targets.forEach((target, ti) => {
    for (let k = 0; k < counts[ti]; k++) {
      map.set(stack.ids[member], target);
      member += 1;
    }
  });
}

interface StepperCellProps {
  count: number;
  color?: string;
  canInc: boolean;
  canDec: boolean;
  onDec: () => void;
  onInc: () => void;
  onAll: () => void;
  decTitle: string;
  incTitle: string;
  allTitle: string;
}

function StepperCell({
  count,
  color,
  canInc,
  canDec,
  onDec,
  onInc,
  onAll,
  decTitle,
  incTitle,
  allTitle,
}: StepperCellProps) {
  return (
    <div className="flex items-center justify-center gap-1">
      <button
        type="button"
        onClick={onDec}
        disabled={!canDec}
        title={decTitle}
        aria-label={decTitle}
        className="flex h-11 w-11 items-center justify-center rounded border border-gray-600 text-lg leading-none text-gray-200 hover:border-gray-400 hover:bg-white/10 disabled:cursor-default disabled:opacity-30 md:h-6 md:w-6 md:text-base"
      >
        -
      </button>
      <button
        type="button"
        onClick={onAll}
        title={allTitle}
        aria-label={allTitle}
        className={`min-w-[2.75rem] rounded px-1 py-2.5 text-center text-sm font-semibold tabular-nums hover:bg-white/10 md:min-w-[1.9rem] md:py-0.5 ${count > 0 ? "text-gray-100" : "text-gray-500"}`}
        style={count > 0 && color ? { color } : undefined}
      >
        {count}
      </button>
      <button
        type="button"
        onClick={onInc}
        disabled={!canInc}
        title={incTitle}
        aria-label={incTitle}
        className="flex h-11 w-11 items-center justify-center rounded border border-gray-600 text-lg leading-none text-gray-200 hover:border-gray-400 hover:bg-white/10 disabled:cursor-default disabled:opacity-30 md:h-6 md:w-6 md:text-base"
      >
        +
      </button>
    </div>
  );
}

interface StackLabelProps {
  stack: AttackerStack;
  t: ReturnType<typeof useTranslation>["t"];
  hoverProps: ReturnType<typeof useInspectHoverProps>;
}

function StackLabel({ stack, t, hoverProps }: StackLabelProps) {
  const ptLabel = objectPtLabel(stack.representative ?? undefined);
  const counters = objectCounterChips(stack.representative ?? undefined);
  return (
    <div className="min-w-0" {...hoverProps(stack.ids[0])}>
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-sm font-medium text-gray-100">
          {stack.name || t("attackTargetPicker.creatureFallback", { id: stack.ids[0] })}
        </span>
        {stack.count > 1 && (
          <span className="shrink-0 rounded bg-gray-700 px-1 text-[10px] font-bold text-gray-100">
            x{stack.count}
          </span>
        )}
        {ptLabel && (
          <span className="shrink-0 rounded bg-amber-900/80 px-1 text-[10px] font-bold text-amber-100">
            {ptLabel}
          </span>
        )}
      </div>
      {counters.length > 0 && (
        <div className="mt-0.5 flex flex-wrap gap-1">
          {counters.map(({ type, count }) => (
            <span key={type} className="rounded bg-sky-900/80 px-1 text-[10px] font-semibold text-sky-100">
              {formatCounterType(type)} x{count}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function getPlayerLabel(
  t: ReturnType<typeof useTranslation>["t"],
  playerId: PlayerId,
  myId: PlayerId,
  teamBased: boolean,
): string {
  if (playerId === myId) return t("attackTargetPicker.you");
  if (teamBased && Math.floor(playerId / 2) === Math.floor(myId / 2)) return t("attackTargetPicker.ally");
  return getPlayerDisplayName(playerId, myId);
}
