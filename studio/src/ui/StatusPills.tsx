"use client";
/** The workspace's honesty marker, safe-state pill, driver and session clock (top of the approved mockup). */
import { useEffect, useState } from "react";
import type { RobotStatus } from "../robot/protocol";

export type SafeState = "active" | "holding" | "estopped" | "disconnected" | "starting";

/** Status colors appear here and nowhere else: they always mean the robot's safe state. */
const SAFE: Record<SafeState, { label: string; tone: string; dot: string }> = {
  active: { label: "ACTIVE", tone: "text-status-active border-status-active/35 bg-status-active/10", dot: "bg-status-active" },
  holding: { label: "HOLDING", tone: "text-status-holding border-status-holding/35 bg-status-holding/10", dot: "bg-status-holding" },
  estopped: { label: "E-STOPPED", tone: "text-status-estopped border-status-estopped/40 bg-status-estopped/12", dot: "bg-status-estopped" },
  disconnected: {
    label: "DISCONNECTED",
    tone: "text-status-disconnected border-status-disconnected/40 bg-status-disconnected/10",
    dot: "bg-status-disconnected",
  },
  starting: { label: "STARTING", tone: "text-muted border-hairline-strong bg-hairline", dot: "bg-status-disconnected" },
};

/** The core's `safeState`; before the first status (and for `torque_off`, which the sim never enters) it is "starting". */
export function safeStateOf(status: RobotStatus | null): SafeState {
  const s = status?.safeState;
  return s === "active" || s === "holding" || s === "estopped" || s === "disconnected" ? s : "starting";
}

export function StatePill({ state }: { state: SafeState }) {
  const { label, tone, dot } = SAFE[state];
  return (
    <span data-testid="safe-state" className={`inline-flex h-6 items-center gap-2 border px-2 font-mono text-micro tracking-[0.08em] ${tone}`}>
      <span aria-hidden className={`size-1.5 rounded-full ${dot}`} />
      <span className="sr-only">Safe state: </span>
      {label}
    </span>
  );
}

/** On every workspace state, never dismissible. */
export function SimBadge() {
  return (
    <span
      title="A physics simulation running in this tab, not a physical robot"
      className="inline-flex h-6 items-center bg-foreground px-2 font-mono text-micro font-medium tracking-[0.16em] text-background"
    >
      SIMULATION
    </span>
  );
}

/** An operator or lease-holder id, in words. */
export function driverLabel(who: string | null | undefined, selfId: string | undefined): string {
  if (!who) return "Nobody";
  return who === `${selfId}:keyboard` ? "Local operator (this tab)" : who;
}

/** A safe-state name in running text, such as the activity log. */
export function StateWord({ state }: { state: SafeState }) {
  const { label, tone } = SAFE[state];
  return <span className={`font-mono ${tone.split(" ")[0]}`}>{label}</span>;
}

const TICK_MS = 250;

/** `m:ss` left until `expiresAt` (epoch ms), or a dash before the session starts. */
export function SessionClock({ expiresAt }: { expiresAt: number | undefined }) {
  const [left, setLeft] = useState<number | null>(null);
  useEffect(() => {
    if (expiresAt === undefined) return;
    const tick = () => setLeft(Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)));
    const id = setInterval(tick, TICK_MS);
    const first = setTimeout(tick, 0);
    return () => {
      clearInterval(id);
      clearTimeout(first);
    };
  }, [expiresAt]);
  const text = left === null ? "—" : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`;
  return (
    <p className="flex items-center gap-2 px-3 font-mono text-micro text-muted">
      <span className="hidden sm:inline">SESSION</span>
      <span className="tabular-nums text-foreground">{text}</span>
    </p>
  );
}
