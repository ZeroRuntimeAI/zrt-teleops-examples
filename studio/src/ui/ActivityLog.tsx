"use client";
/**
 * The activity log: the core's lease and safe-state events, the app's own session milestones, and
 * the command counts from the latest status. Every row and number comes from the running robot.
 */
import type { ReactNode } from "react";
import type { RobotStatus } from "../robot/protocol";
import { StateWord, driverLabel, type SafeState } from "./StatusPills";
import { Eyebrow } from "./ui";

export const LOG_CAP = 200;

/** A worker `event` (`{op:"ev", kind, ...}`) or one the app adds (`{op:"app", what, ...}`). */
export type LogEvent = Record<string, unknown>;
export type LogEntry = { id: number; at: number; event: LogEvent };

const CORE_KINDS = new Set(["safe_state", "lease_granted", "lease_released", "disconnected"]);
/** Reset e-stops internally (host.ts) before it clears: that is not the visitor's Stop. */
const RESET_SOURCE = "studio-reset";

/** Whether a worker event belongs in the log. */
export function shown(e: LogEvent): boolean {
  if (e.op !== "ev" || !CORE_KINDS.has(String(e.kind))) return false;
  return !(e.kind === "safe_state" && e.source === RESET_SOURCE);
}

/** Newest first, at most `LOG_CAP` rows. */
export function appendLog(rows: readonly LogEntry[], entry: LogEntry): LogEntry[] {
  return [entry, ...rows].slice(0, LOG_CAP);
}

/** The core's `SafeStateReason` strings, in words. */
const REASONS: Record<string, string> = {
  starvation: "watchdog · no fresh commands",
  estop: "e-stop",
  lease_lost: "lease lost",
  transport_lost: "room connection lost",
  robot_fault: "robot fault",
  manual: "cleared",
  stalled: "control loop stalled",
};

export const reasonText = (reason: unknown) => (typeof reason === "string" ? (REASONS[reason] ?? reason.replace(/_/g, " ")) : null);

const SAFE_STATES = new Set(["active", "holding", "estopped", "disconnected"]);
const isSafe = (s: unknown): s is SafeState => typeof s === "string" && SAFE_STATES.has(s);
const str = (v: unknown) => (typeof v === "string" ? v : "");

const Mono = ({ children }: { children: ReactNode }) => <code className="font-mono text-foreground">{children}</code>;

const VOICE_STEPS: Record<string, string> = {
  dispatched: "Voice agent requested",
  joined: "Voice agent joined the room",
};

function voiceStep(e: LogEvent): ReactNode {
  const step = str(e.step);
  return step === "queued" ? <>Voice requested · queued, #{Number(e.position)} in line</> : (VOICE_STEPS[step] ?? step);
}

function describe(e: LogEvent, selfId: string | undefined): ReactNode {
  switch (e.op === "app" ? `app:${str(e.what)}` : str(e.kind)) {
    case "safe_state": {
      const reason = e.state === "estopped" && e.source === "studio-ui" ? "Stop pressed · latched until Reset" : reasonText(e.reason);
      return (
        <>
          {isSafe(e.state) ? <StateWord state={e.state} /> : <Mono>{str(e.state)}</Mono>}
          {reason && <> · {reason}</>}
        </>
      );
    }
    case "lease_granted":
      return <>Lease granted → {driverLabel(str(e.holder) || null, selfId)}</>;
    case "lease_released":
      return <>Lease released{e.why ? <> · {str(e.why)}</> : null}</>;
    case "disconnected":
      return <>Room connection lost{e.why ? <> · {str(e.why)}</> : null}</>;
    case "app:start":
      return (
        <>
          Session started · room <Mono>{str(e.roomId)}</Mono>
        </>
      );
    case "app:reset":
      return <>Reset · fresh scene</>;
    case "app:cube":
      return (
        <>
          <span className="capitalize">{str(e.color)}</span> cube in the box · {Number(e.count)} of 4
        </>
      );
    case "app:voice":
      return voiceStep(e);
    case "app:ended":
      return <>Time limit reached · left the room</>;
    default:
      return <Mono>{JSON.stringify(e)}</Mono>;
  }
}

const clock = (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour12: false });

export const COUNT_TERMS = [
  ["Applied", "accepted"],
  ["Clamped", "clamped"],
  ["Rejected", "rejected"],
] as const;

/** Applied (per-tick writes to the arm), clamped and rejected, from the core's own counters. */
export function Counts({ status, size = "sm", className = "" }: { status: RobotStatus | null; size?: "sm" | "lg"; className?: string }) {
  return (
    <dl className={`grid grid-cols-3 gap-px bg-hairline ${className}`}>
      {COUNT_TERMS.map(([term, key]) => (
        <div key={key} className={`bg-surface ${size === "lg" ? "px-3 py-2.5" : "px-5 py-2.5"}`}>
          <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{term}</dt>
          <dd className={`mt-0.5 font-mono tabular-nums ${size === "lg" ? "text-lg leading-none" : "text-sm"}`}>
            {status ? status[key].toLocaleString("en-US") : "—"}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function ActivityLog({
  log,
  status,
  selfId,
  headingId,
  className = "",
}: {
  log: readonly LogEntry[];
  status: RobotStatus | null;
  selfId: string | undefined;
  headingId: string;
  className?: string;
}) {
  return (
    <section aria-labelledby={headingId} className={`flex min-h-0 flex-col ${className}`}>
      <div className="flex items-baseline justify-between px-5 pb-2.5 pt-1">
        <Eyebrow as="h2" id={headingId}>
          Activity
        </Eyebrow>
        <span className="font-mono text-micro text-muted">newest first</span>
      </div>
      <Counts status={status} className="shrink-0 border-y border-hairline" />
      <ol className="min-h-0 flex-1 overflow-y-auto px-5 py-3 text-ui">
        {log.map(({ id, at, event }) => (
          <li key={id} className="grid grid-cols-[4.25rem_1fr] gap-2 py-1.5 leading-snug">
            <time dateTime={new Date(at).toISOString()} className="font-mono text-micro leading-5 text-muted tabular-nums">
              {clock(at)}
            </time>
            <span className="min-w-0 break-words text-foreground/85">{describe(event, selfId)}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
