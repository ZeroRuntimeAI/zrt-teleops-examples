"use client";
/** The right rail: the task's live progress over the activity log. Collapses to a "Task n/4" button. */
import { useId } from "react";
import type { RobotStatus } from "../robot/protocol";
import { ActivityLog, type LogEntry } from "./ActivityLog";
import { Eyebrow, Icon, glass, iconButton } from "./ui";
import type { Voice } from "./useVoice";
import { VoiceTranscript } from "./VoicePanel";

/** The cubes' paint from scene.xml, so the progress chips match the stage. */
const CUBES = [
  ["red", "#f2261f"],
  ["green", "#33bf40"],
  ["blue", "#2659f2"],
  ["yellow", "#ffd91f"],
] as const;
export const CUBE_COUNT = CUBES.length;

export function TaskBlock({ status }: { status: RobotStatus | null }) {
  const headingId = useId();
  const inBox: readonly string[] = status?.cubesInBox ?? [];
  return (
    <section aria-labelledby={headingId} className="px-5 pb-6 pt-5">
      <Eyebrow>Task</Eyebrow>
      <h2 id={headingId} className="mt-2.5 text-lg font-medium leading-snug tracking-tight">
        Put all the cubes in the green box.
      </h2>
      <div className="mt-6 flex items-end justify-between gap-4">
        <p className="flex items-baseline gap-2">
          <span className="text-5xl font-light leading-none tracking-tight tabular-nums">{inBox.length}</span>
          <span className="text-ui text-muted">of {CUBE_COUNT} in the box</span>
        </p>
        <ul className="flex gap-1.5">
          {CUBES.map(([color, paint]) => {
            const done = inBox.includes(color);
            return (
              <li
                key={color}
                title={`${color}: ${done ? "in the box" : "on the table"}`}
                className="size-5 border"
                style={{ background: done ? paint : "transparent", borderColor: done ? paint : `${paint}99` }}
              >
                <span className="sr-only">
                  {color}: {done ? "in the box" : "on the table"}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="mt-4 h-[3px] bg-hairline-strong">
        <div className="h-full bg-foreground transition-transform duration-[var(--duration-normal)] origin-left" style={{ transform: `scaleX(${inBox.length / CUBE_COUNT})` }} />
      </div>
    </section>
  );
}

export function TaskRail({
  status,
  log,
  selfId,
  voice,
  collapse,
}: {
  status: RobotStatus | null;
  log: readonly LogEntry[];
  selfId: string | undefined;
  /** Given only while the rail is on screen, so the transcript exists once in the page. */
  voice?: Voice;
  collapse(): void;
}) {
  const activityId = useId();
  const voiceId = useId();
  return (
    <aside aria-label="Task and activity" className={`pointer-events-auto hidden min-h-0 w-80 shrink-0 flex-col overflow-y-auto lg:flex xl:w-[22.5rem] ${glass}`}>
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-hairline pl-5 pr-1">
        <Eyebrow>Tabletop · SO-101</Eyebrow>
        <button type="button" onClick={collapse} aria-label="Collapse the panel" className={`${iconButton} size-9`}>
          <Icon name="right" />
        </button>
      </div>
      <TaskBlock status={status} />
      {/* With the drawer open the rail is short: the log keeps a minimum and the rail scrolls. */}
      <ActivityLog log={log} status={status} selfId={selfId} headingId={activityId} className="min-h-56 flex-1" />
      {voice && <VoiceTranscript voice={voice} headingId={voiceId} />}
    </aside>
  );
}
