"use client";
/** `/tabletop`: the live stage under the approved mockup's chrome, with the rail, the developer drawer and every edge state. */
import Link from "next/link";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { DevContent, DevDrawer, type DevProps } from "./DevDrawer";
import { Dock, MobileDock } from "./Dock";
import { ActivityLog } from "./ActivityLog";
import { ErrorState, Plate } from "./ErrorState";
import { SessionClock, SimBadge, StatePill, driverLabel, safeStateOf } from "./StatusPills";
import { Stage, type Clear } from "./Stage";
import { CUBE_COUNT, TaskBlock, TaskRail } from "./TaskRail";
import { Eyebrow, Icon, LINKS, btn, glass, iconButton } from "./ui";
import { useDrive } from "./useDrive";
import { useRobot, type LoadProgress, type Progress, type Robot } from "./useRobot";
import { useServoSound, useServoSoundPref } from "./servoSound";
import { useVoice, type Voice } from "./useVoice";
import { VoiceTranscript, useWide } from "./VoicePanel";

/** Rail width and drawer height on large screens; the touch dock on small ones. */
const RAIL_PX = 360;
const DRAWER_PX = 300;
const DOCK_PX = 60;
const MOBILE_DOCK_PX = 380;

type Sheet = "task" | "activity" | "dev";
const SHEET_TITLES: Record<Sheet, string> = { task: "Task", activity: "Activity", dev: "Developer" };
const MB = 1024 * 1024;

/** The signed-in name for the drawer header, or null. Signed out, or the lookup failed: no name either way. */
function useSignedInName(): string | null {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    fetch("/api/me", { signal: abort.signal })
      .then((res) => (res.ok ? res.json() : null))
      .then((body: unknown) => {
        const me = body as { signedIn?: unknown; name?: unknown } | null;
        if (me?.signedIn === true && typeof me.name === "string") setName(me.name);
      })
      .catch(() => {}); // The name is decoration: a failed lookup reads as signed out.
    return () => abort.abort();
  }, []);
  return name;
}

/** True after the tab comes back from the background while driving, until dismissed or a key goes down. */
function usePausedBanner(live: boolean): [boolean, () => void] {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (!live) return;
    let wasHidden = document.visibilityState === "hidden";
    const onVisibility = () => {
      if (document.visibilityState === "hidden") wasHidden = true;
      else if (wasHidden) {
        wasHidden = false;
        setPaused(true);
      }
    };
    const onKey = () => setPaused(false);
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("keydown", onKey);
    };
  }, [live]);
  const dismiss = useCallback(() => setPaused(false), []);
  return [paused, dismiss];
}

function Banner({ tone, children, dismiss }: { tone: string; children: ReactNode; dismiss?: () => void }) {
  return (
    <div role="status" className={`pointer-events-auto flex max-w-lg items-start gap-4 border-l-2 p-4 pr-5 ${tone} ${glass}`}>
      <div className="min-w-0">{children}</div>
      {dismiss && (
        <button type="button" onClick={dismiss} aria-label="Dismiss" className={`${iconButton} -m-1 size-8 shrink-0`}>
          <Icon name="close" />
        </button>
      )}
    </div>
  );
}

const mb = (bytes: number) => (bytes / MB).toFixed(1);

function ProgressRow({ label, value, done }: { label: string; value: string; done: number }) {
  return (
    <div>
      <p className="flex justify-between gap-3 text-ui">
        <span className="text-foreground/85">{label}</span>
        <span className="font-mono text-micro tabular-nums text-muted">{value}</span>
      </p>
      <div className="mt-2 h-[3px] bg-hairline-strong">
        <div className="h-full origin-left bg-foreground" style={{ transform: `scaleX(${done})` }} />
      </div>
    </div>
  );
}

/** A `.wasm` download: bytes of total when the server sent a length (and compression didn't make it a lie). */
function wasmRow(p: Progress | undefined): { value: string; done: number } {
  if (!p) return { value: "waiting", done: 0 };
  if (p.total > 0 && p.loaded <= p.total) return { value: `${mb(p.loaded)} / ${mb(p.total)} MB`, done: p.loaded / p.total };
  return { value: `${mb(p.loaded)} MB`, done: 0 }; // total unknown until the download ends
}

function LoadingPlate({ progress }: { progress: LoadProgress }) {
  const { files } = progress;
  return (
    <Plate>
      <Eyebrow>Starting your session</Eyebrow>
      <h2 className="mt-3 text-2xl font-medium tracking-tight">Loading the robot</h2>
      <div className="mt-6 space-y-4" role="group" aria-label="Loading progress">
        <ProgressRow label="Robot model and meshes" value={`${files.loaded} / ${files.total}`} done={files.total ? files.loaded / files.total : 0} />
        <ProgressRow label="Physics engine · WebAssembly" {...wasmRow(progress.physics)} />
        <ProgressRow label="Teleop core · WebAssembly" {...wasmRow(progress.core)} />
      </div>
      <p className="mt-6 font-mono text-micro leading-relaxed text-muted">The simulation runs in this tab. Nothing is simulated on our servers.</p>
    </Plate>
  );
}

function CenterPlate({ robot, restart }: { robot: Robot; restart(): void }) {
  switch (robot.phase) {
    case "loading":
      return <LoadingPlate progress={robot.progress} />;
    case "error":
      return robot.error ? <ErrorState error={robot.error} retry={restart} /> : null;
    case "disconnected":
      return (
        <Plate alert>
          <Eyebrow>Room</Eyebrow>
          <h2 className="mt-3 text-2xl font-medium tracking-tight">Lost the connection</h2>
          <p className="mt-2 text-sm leading-relaxed text-foreground/80">
            The simulated arm held its last position. This session can&apos;t reconnect, so start a new one. It takes a few seconds.
          </p>
          <button type="button" onClick={restart} className={`${btn.primary} mt-6`}>
            Start a new session
          </button>
        </Plate>
      );
    case "ended": {
      const n = robot.status?.cubesInBox.length ?? 0;
      return (
        <Plate>
          <Eyebrow>Time&apos;s up</Eyebrow>
          <h2 className="mt-3 text-[2rem] font-medium leading-tight tracking-tight">Session ended</h2>
          <p className="mt-2 text-sm leading-relaxed text-foreground/80">
            You got {n} of {CUBE_COUNT} cubes in the box. Start another for a fresh room and a new scene.
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-3">
            <button type="button" onClick={restart} className={btn.primary}>
              Start another
            </button>
            <a
              href={LINKS.github}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-ui text-foreground/85 underline-offset-4 hover:text-foreground hover:underline"
            >
              Run it on your own machine <Icon name="external" className="size-3" />
            </a>
          </div>
        </Plate>
      );
    }
    default:
      return null;
  }
}

function MobileSheet({
  sheet,
  close,
  robot,
  voice,
  dev,
  name,
}: {
  sheet: Sheet;
  close(): void;
  robot: Robot;
  voice: Voice;
  dev: DevProps;
  name: string | null;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);
  return (
    <section aria-label={SHEET_TITLES[sheet]} className="absolute inset-x-0 bottom-0 top-[22%] z-10 flex flex-col border-t border-hairline-strong bg-surface lg:hidden">
      <header className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-hairline pl-5 pr-1.5">
        <h2 className="text-sm font-medium">{SHEET_TITLES[sheet]}</h2>
        {sheet === "dev" && name && <span className="ml-auto truncate text-ui text-muted">{name}</span>}
        <button type="button" onClick={close} aria-label="Close" autoFocus className={`${iconButton} size-11`}>
          <Icon name="close" />
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {sheet === "task" && <TaskBlock status={robot.status} />}
        {sheet === "activity" && (
          <>
            <ActivityLog log={robot.log} status={robot.status} selfId={robot.selfId} headingId="sheet-activity" className="pt-4" />
            <VoiceTranscript voice={voice} headingId="sheet-voice" />
          </>
        )}
        {sheet === "dev" && <DevContent {...dev} />}
      </div>
    </section>
  );
}

type SessionProps = { files: readonly string[]; token?: string; restart(): void; joinWithToken(token: string): void; name: string | null };

function Session({ files, token, restart, joinWithToken, name }: SessionProps) {
  const robot = useRobot(files, token);
  const live = robot.phase === "ready";
  const { press, release } = useDrive(live, robot.canStop, robot.jog, robot.stop);
  const voice = useVoice(robot);
  const sound = useServoSoundPref();
  useServoSound(robot.jointAngles, sound.on);
  const wide = useWide();
  const [paused, dismissPaused] = usePausedBanner(live);
  const [rail, setRail] = useState(true);
  const [drawer, setDrawer] = useState(false);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const state = robot.phase === "disconnected" ? "disconnected" : safeStateOf(robot.status);
  const estopped = state === "estopped";
  const driver = driverLabel(robot.status?.activeOperator, robot.selfId);
  const dock = { live, canStop: robot.canStop, estopped, driver, voice, wide, stop: robot.stop, reset: robot.reset, press, release, sound };
  const staged = robot.phase !== "loading" && robot.phase !== "error";
  const dimmed = robot.phase === "ended" || robot.phase === "disconnected";
  const inBox = robot.status?.cubesInBox.length ?? 0;
  const { fail } = robot;
  const onStageError = useCallback((message: string) => fail({ kind: "load", message }), [fail]);
  const closeSheet = useCallback(() => setSheet(null), []);
  const clear: Clear = { lg: [staged && rail ? RAIL_PX : 0, drawer ? DRAWER_PX : DOCK_PX], sm: [0, MOBILE_DOCK_PX] };
  const dev: DevProps = { status: robot.status, selfId: robot.selfId, roomId: robot.roomId, live, setJoints: robot.setJoints, joinWithToken };
  const toggle = "hidden items-center gap-2 border-l border-hairline px-3.5 text-ui transition-colors duration-[var(--duration-fast)] lg:flex";

  return (
    <div className="relative h-dvh overflow-hidden" data-phase={robot.phase}>
      <h1 className="sr-only">Tabletop: put the cubes in the box</h1>
      <Stage files={robot.files} seed={robot.seed} poses={robot.poses} frontCanvas={robot.frontCanvas} clear={clear} onError={onStageError} />
      {dimmed && <div className="absolute inset-0 bg-background/60 backdrop-blur-[3px]" />}

      <div className="pointer-events-none absolute inset-0 flex flex-col gap-3 p-3 lg:gap-4 lg:p-4">
        <header className="flex items-start justify-between gap-3">
          <div className={`pointer-events-auto flex h-11 min-w-0 items-stretch ${glass}`}>
            <Link href="/" aria-label="Back to Studio home" className={`${iconButton} w-10 shrink-0 border-r border-hairline`}>
              <Icon name="back" />
            </Link>
            <div className="flex min-w-0 items-center gap-2 px-2.5 sm:px-3">
              <SimBadge />
              <StatePill state={state} />
            </div>
            <div className="hidden flex-col justify-center border-l border-hairline px-3.5 lg:flex">
              <span className="font-mono text-[10px] uppercase leading-3 tracking-[0.14em] text-muted">Driving</span>
              <span className="text-ui leading-5">{driver}</span>
            </div>
          </div>
          <div className={`pointer-events-auto flex h-11 shrink-0 items-stretch ${glass}`}>
            <SessionClock expiresAt={robot.expiresAt} />
            <button
              type="button"
              onClick={() => setDrawer((d) => !d)}
              aria-expanded={drawer}
              className={`${toggle} ${drawer ? "bg-hairline-strong text-foreground" : "text-foreground/85 hover:bg-hairline-strong hover:text-foreground"}`}
            >
              <Icon name="code" />
              Developer
            </button>
            <button
              type="button"
              onClick={() => setRail((r) => !r)}
              aria-expanded={rail}
              aria-label={rail ? "Hide the task panel" : "Show the task panel"}
              className={`${iconButton} hidden w-10 border-l border-hairline lg:grid`}
            >
              <Icon name="panel" />
            </button>
          </div>
        </header>

        <div className="flex min-h-0 flex-1 gap-4">
          <main className="flex min-w-0 flex-1 flex-col gap-4">
            {estopped && live && (
              <Banner tone="border-l-status-estopped">
                <p className="text-sm font-medium text-status-estopped">E-stop latched</p>
                <p className="mt-1 text-ui leading-relaxed text-foreground/80">
                  The arm is holding where it stopped. Reset clears the e-stop and lays out a fresh scene.
                </p>
              </Banner>
            )}
            {paused && live && (
              <Banner tone="border-l-status-holding" dismiss={dismissPaused}>
                <p className="text-sm font-medium leading-snug">Paused while this tab was in the background — the robot held its position.</p>
                <p className="mt-1 text-ui text-muted">Press a drive key to take control again.</p>
              </Banner>
            )}
            {robot.notice && (
              <Banner tone="border-l-foreground/40" dismiss={robot.dismissNotice}>
                <p className="text-sm font-medium leading-snug">The robot reported an error and kept running.</p>
                <p className="mt-1 break-words font-mono text-micro text-muted">{robot.notice}</p>
              </Banner>
            )}
            <div className="flex flex-1 items-center justify-center">
              <CenterPlate robot={robot} restart={restart} />
            </div>
            <Dock {...dock} />
          </main>
          {staged &&
            (rail ? (
              <TaskRail status={robot.status} log={robot.log} selfId={robot.selfId} voice={wide ? voice : undefined} collapse={() => setRail(false)} />
            ) : (
              <button
                type="button"
                onClick={() => setRail(true)}
                className={`pointer-events-auto hidden h-11 shrink-0 items-center gap-2 self-start px-3.5 text-ui text-foreground/85 transition-colors hover:bg-hairline-strong lg:flex ${glass}`}
              >
                Task{" "}
                <span className="font-mono text-micro text-muted">
                  {inBox}/{CUBE_COUNT}
                </span>
                <Icon name="left" className="size-3.5 text-muted" />
              </button>
            ))}
        </div>
        {drawer && <DevDrawer {...dev} name={name} close={() => setDrawer(false)} />}
        <MobileDock {...dock}>
          <nav aria-label="Panels" className="grid grid-cols-3 border-t border-hairline">
            {(Object.keys(SHEET_TITLES) as Sheet[]).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setSheet(s)}
                className="flex h-11 items-center justify-center gap-1.5 text-ui text-foreground/85 transition-colors hover:bg-hairline-strong active:bg-foreground/15 [&:not(:first-child)]:border-l [&:not(:first-child)]:border-hairline"
              >
                {SHEET_TITLES[s]}
                {s === "task" && staged && (
                  <span className="font-mono text-micro text-muted">
                    {inBox}/{CUBE_COUNT}
                  </span>
                )}
              </button>
            ))}
          </nav>
        </MobileDock>
      </div>

      {sheet && <MobileSheet sheet={sheet} close={closeSheet} robot={robot} voice={voice} dev={dev} name={name} />}
      <p className="sr-only" aria-live="polite">
        Safe state: {state}
      </p>
    </div>
  );
}

/** Each run is one session: Retry, "Start another" and a pasted token remount it, which leaves the old room. */
export function Workspace({ files }: { files: readonly string[] }) {
  const [run, setRun] = useState<{ n: number; token?: string }>({ n: 0 });
  const name = useSignedInName();
  const restart = useCallback(() => setRun((r) => ({ ...r, n: r.n + 1 })), []);
  const joinWithToken = useCallback((token: string) => setRun((r) => ({ n: r.n + 1, token })), []);
  return <Session key={run.n} files={files} token={run.token} restart={restart} joinWithToken={joinWithToken} name={name} />;
}
