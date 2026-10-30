"use client";
/** The drive dock (large screens) and the touch dock (small screens), from the approved mockup. */
import type { MouseEvent, PointerEvent, ReactNode } from "react";
import { Icon, Kbd, glass } from "./ui";
import { LanguageSwitch, LatestTool, VoiceStrip } from "./VoicePanel";
import type { Voice } from "./useVoice";

export type DockProps = {
  /** Controls are usable: the robot is up and the session is on. */
  live: boolean;
  /** A robot exists to stop: Stop works in every phase but before boot and after a fatal error. */
  canStop: boolean;
  estopped: boolean;
  driver: string;
  voice: Voice;
  /** Large screen: the desktop dock is the one showing, so the one that shows the voice line. */
  wide: boolean;
  stop(): void;
  reset(): void;
  /** Hold buttons: a `KEYMAP` code goes down and comes up. */
  press(code: string): void;
  release(code: string): void;
  /** The servo sound, on or off. */
  sound: { on: boolean; toggle(): void };
};

const NO_VOICE = "Voice is not available yet";

/** Keyboard or Voice. Voice asks for an agent, and stays selected while the visitor waits in line. */
function ModeSwitch({ voice, className = "" }: { voice: Voice; className?: string }) {
  const tab = "flex h-10 flex-1 items-center justify-center gap-2 border-b-2 px-3.5 text-ui transition-colors duration-[var(--duration-fast)]";
  return (
    <div role="group" aria-label="Control mode" className={`flex items-stretch gap-1 p-1.5 ${className}`}>
      <button
        type="button"
        aria-pressed={!voice.active}
        onClick={voice.off}
        className={`${tab} ${voice.active ? "border-transparent text-muted hover:text-foreground" : "border-primary bg-hairline-strong text-foreground"}`}
      >
        <Icon name="keyboard" /> Keyboard
      </button>
      <button
        type="button"
        aria-pressed={voice.active}
        // Disabled, not hidden: the visitor sees Voice exists. A disabled button has no hover, so the reason is also its name.
        disabled={!voice.available}
        aria-label={voice.available ? undefined : NO_VOICE}
        title={voice.available ? undefined : NO_VOICE}
        onClick={voice.on}
        className={`${tab} ${
          !voice.available
            ? "cursor-not-allowed border-transparent text-muted opacity-50"
            : voice.active
              ? "border-primary bg-hairline-strong text-foreground"
              : "border-transparent text-muted hover:text-foreground"
        }`}
      >
        <Icon name="mic" /> Voice
      </button>
      <LanguageSwitch voice={voice} />
    </div>
  );
}

const KEY_GROUPS = [
  [["W", "A", "S", "D"], "move"],
  [["R", "F"], "up · down"],
  [["Q", "E"], "roll"],
  [["Z", "X"], "grip"],
] as const;

function KeyLegend() {
  return (
    <>
      <div className="hidden items-center gap-5 xl:flex">
        {KEY_GROUPS.map(([keys, label]) => (
          <span key={label} className="flex items-center gap-2">
            <span className="flex gap-0.5">
              {keys.map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
            </span>
            <span className="text-ui text-muted">{label}</span>
          </span>
        ))}
      </div>
      <p className="flex items-center gap-2 text-ui text-muted xl:hidden">
        <span className="flex gap-0.5">
          {["W", "A", "S", "D"].map((k) => (
            <Kbd key={k}>{k}</Kbd>
          ))}
        </span>
        drive
      </p>
    </>
  );
}

/** Stop is on screen in every state; with no session to stop it is shown muted, never hidden. */
function StopButton({ canStop, estopped, stop, className = "" }: Pick<DockProps, "canStop" | "estopped" | "stop"> & { className?: string }) {
  return (
    <button
      type="button"
      onClick={stop}
      disabled={!canStop}
      // Named by its visible text ("Stop", plus the Space keycap where shown) so speech input matches it.
      aria-label={estopped ? "Stopped. E-stop is latched" : undefined}
      aria-keyshortcuts="Space"
      className={`flex items-center justify-center gap-3 px-5 transition-colors duration-[var(--duration-fast)] disabled:opacity-40 ${
        estopped ? "bg-status-estopped/15 text-status-estopped" : "bg-foreground text-background hover:bg-foreground/90 active:bg-foreground/75"
      } ${className}`}
    >
      <Icon name="stop" className={`size-4 ${estopped ? "" : "text-status-estopped"}`} />
      <span className="text-sm font-semibold">{estopped ? "Stopped" : "Stop"}</span>
      {!estopped && (
        <kbd className="hidden border border-background/25 px-1.5 font-mono text-[10px] leading-4 text-background/70 xl:inline">Space</kbd>
      )}
    </button>
  );
}

function SoundButton({ sound, className = "" }: Pick<DockProps, "sound"> & { className?: string }) {
  return (
    <button
      type="button"
      onClick={sound.toggle}
      aria-pressed={sound.on}
      aria-label="Motor sound"
      title={sound.on ? "Motor sound on" : "Motor sound off"}
      className={`flex items-center justify-center px-3.5 transition-colors duration-[var(--duration-fast)] hover:bg-hairline-strong active:bg-foreground/15 ${
        sound.on ? "text-foreground/85 hover:text-foreground" : "text-muted hover:text-foreground"
      } ${className}`}
    >
      <Icon name={sound.on ? "sound" : "soundOff"} />
    </button>
  );
}

function ResetButton({ estopped, reset, className = "" }: Pick<DockProps, "estopped" | "reset"> & { className?: string }) {
  return (
    <button
      type="button"
      onClick={reset}
      className={`flex items-center justify-center gap-2 px-4 text-ui transition-colors duration-[var(--duration-fast)] ${
        estopped
          ? "bg-primary font-medium text-on-primary hover:brightness-110 active:brightness-95"
          : "text-foreground/85 hover:bg-hairline-strong hover:text-foreground active:bg-foreground/15"
      } ${className}`}
    >
      <Icon name="reset" />
      Reset
    </button>
  );
}

export function Dock(props: DockProps) {
  const { live, voice, wide } = props;
  const voiceLine = wide && (voice.active || voice.error);
  return (
    <div className="pointer-events-auto relative mx-auto hidden max-w-full lg:block">
      <div className={`flex h-[3.25rem] items-stretch ${glass}`}>
        <div inert={!live} className={`flex items-stretch ${live ? "" : "opacity-40"}`}>
          <ModeSwitch voice={voice} />
          <div className="flex items-center border-l border-hairline px-4 xl:px-5">{voiceLine ? <VoiceStrip voice={voice} /> : <KeyLegend />}</div>
          <ResetButton {...props} className="border-l border-hairline" />
        </div>
        <SoundButton {...props} className="border-l border-hairline" />
        <StopButton {...props} />
      </div>
    </div>
  );
}

const pad =
  "grid touch-none select-none place-items-center border border-hairline-strong bg-surface-raised text-foreground/85 active:bg-foreground/15";

/** On-screen hold buttons: the touch version of every jog key. Roll sits in the pad's top corners. */
function TouchPad({ press, release }: Pick<DockProps, "press" | "release">) {
  const hold = (code: string) => ({
    onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
      e.currentTarget.setPointerCapture(e.pointerId);
      press(code);
    },
    onPointerUp: () => release(code),
    onPointerCancel: () => release(code),
    onLostPointerCapture: () => release(code),
    onContextMenu: (e: MouseEvent) => e.preventDefault(), // no long-press menu on touch
  });
  const pads = [
    ["rollLeft", "Roll left", "KeyQ", "col-start-1 row-start-1"],
    ["up", "Forward", "KeyW", "col-start-2"],
    ["rollRight", "Roll right", "KeyE", "col-start-3 row-start-1"],
    ["left", "Left", "KeyA", "col-start-1 row-start-2"],
    ["right", "Right", "KeyD", "col-start-3 row-start-2"],
    ["down", "Back", "KeyS", "col-start-2 row-start-3"],
  ] as const;
  const pairs = [
    ["Height", [["Up", "KeyR"], ["Down", "KeyF"]]],
    ["Gripper", [["Open", "KeyX"], ["Close", "KeyZ"]]],
  ] as const;
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-3">
      <div role="group" aria-label="Move and roll the gripper" className="grid grid-cols-3 grid-rows-3 gap-1">
        {pads.map(([icon, label, code, place]) => (
          <button key={icon} type="button" aria-label={`${label} (hold)`} className={`${pad} size-11 ${place}`} {...hold(code)}>
            <Icon name={icon} />
          </button>
        ))}
      </div>
      {pairs.map(([group, buttons]) => (
        <div key={group} role="group" aria-label={group} className="grid flex-1 gap-1">
          {buttons.map(([label, code]) => (
            <button key={label} type="button" aria-label={`${group} ${label.toLowerCase()} (hold)`} className={`${pad} h-11 text-ui`} {...hold(code)}>
              {label}
            </button>
          ))}
          <p className="pt-0.5 text-center font-mono text-[10px] uppercase tracking-[0.14em] text-muted">{group}</p>
        </div>
      ))}
    </div>
  );
}

/** `children` sit under Stop: the panel tabs. */
export function MobileDock({ children, ...props }: DockProps & { children?: ReactNode }) {
  const { live, driver, voice, wide } = props;
  return (
    <div className={`pointer-events-auto lg:hidden ${glass}`}>
      {/* With no session to drive, the small screen keeps only Stop. */}
      <div className={live ? "" : "hidden"}>
        <p className="truncate border-b border-hairline px-3 py-2 text-ui">
          <span className="mr-2 font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Driving</span>
          {driver}
        </p>
        <div className="flex items-stretch border-b border-hairline">
          <ModeSwitch voice={voice} className="flex-1" />
          <ResetButton {...props} className="border-l border-hairline" />
          <SoundButton {...props} className="border-l border-hairline" />
        </div>
        {!wide && (voice.active || voice.error) && (
          <div className="space-y-3 border-b border-hairline px-3 py-3">
            <VoiceStrip voice={voice} />
            <LatestTool state={voice.state} />
          </div>
        )}
        {/* The pad comes back when Keyboard is chosen; while the agent drives, the strip takes its place. */}
        {(!voice.active || voice.state.agent === "queued") && <TouchPad {...props} />}
      </div>
      <StopButton {...props} className="h-14 w-full" />
      {children}
    </div>
  );
}
