"use client";
/**
 * The developer drawer: the core's lease and safety state, the command counts, a slider per joint,
 * and how to drive this arm from your own machine. Every value is read from the running robot.
 */
import { useId, useState, type CSSProperties, type ReactNode } from "react";
import type { RobotStatus } from "../robot/protocol";
import { ROBOT_ID } from "../robot/host";
import { JOINTS, LIMITS, type JointName, type Joints } from "../sim/jointMap";
import { Counts, reasonText } from "./ActivityLog";
import { StatePill, driverLabel, safeStateOf } from "./StatusPills";
import { Eyebrow, Icon, LINKS, btn, glass, iconButton } from "./ui";

export type DevProps = {
  status: RobotStatus | null;
  selfId: string | undefined;
  roomId: string | undefined;
  /** The robot is up and the session on: the sliders drive. */
  live: boolean;
  setJoints(joints: Partial<Joints>, held: boolean): void;
  /** Move Studio into a new room in the pasted token's account. */
  joinWithToken(token: string): void;
};

/** The core's fixed safety envelope (zeroruntime-teleop-core `SafetyConfig::default`); JS cannot change it. */
const LIMITS_LINE = "watchdog 0.5 s · staleness 100 ms · slew 0.75";

function Field({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr] items-baseline gap-3 py-1.5">
      <dt className="text-ui text-muted">{term}</dt>
      <dd className="min-w-0 break-words text-ui text-foreground">{children}</dd>
    </div>
  );
}

function LeaseColumn({ status, selfId }: Pick<DevProps, "status" | "selfId">) {
  const leaseId = useId();
  const cmdId = useId();
  const reason = reasonText(status?.reason);
  return (
    <div className="space-y-6 p-5">
      <section aria-labelledby={leaseId}>
        <Eyebrow as="h3" id={leaseId}>
          Lease and safety
        </Eyebrow>
        <dl className="mt-3">
          <Field term="Lease holder">{driverLabel(status?.leaseHolder, selfId)}</Field>
          <Field term="Active operator">{driverLabel(status?.activeOperator, selfId)}</Field>
          <Field term="Safe state">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <StatePill state={safeStateOf(status)} />
              {reason && <span className="font-mono text-micro text-muted">{reason}</span>}
            </span>
          </Field>
          <Field term="Deadman">{status ? (status.deadman ? "Held" : "Released") : "—"}</Field>
          <Field term="Limits">
            <span className="font-mono text-micro text-foreground/85">{LIMITS_LINE}</span>
          </Field>
        </dl>
      </section>
      <section aria-labelledby={cmdId}>
        <Eyebrow as="h3" id={cmdId}>
          Commands
        </Eyebrow>
        <Counts status={status} size="lg" className="mt-3 border border-hairline" />
      </section>
    </div>
  );
}

/** One joint: shows the measured angle; dragging holds the deadman and drives toward the slider. */
function JointRow({ name, measured, live, setJoints }: { name: JointName; measured: number | undefined; live: boolean } & Pick<DevProps, "setJoints">) {
  const [drag, setDrag] = useState<number | null>(null);
  const [min, max] = LIMITS[name];
  const value = drag ?? measured ?? 0;
  const unit = name === "gripper" ? "%" : "°";
  const end = () => {
    if (drag === null) return;
    setJoints({ [name]: drag }, false);
    setDrag(null);
  };
  return (
    <tr className="border-t border-hairline">
      <th scope="row" className="py-2 pr-3 text-left font-mono text-micro font-normal text-foreground/85">
        {name}
      </th>
      <td className="w-full py-2">
        <input
          type="range"
          min={min}
          max={max}
          step={0.1}
          value={value}
          disabled={!live || measured === undefined}
          onPointerDown={(e) => e.currentTarget.setPointerCapture(e.pointerId)}
          onChange={(e) => {
            const v = Number(e.target.value);
            setDrag(v);
            setJoints({ [name]: v }, true);
          }}
          onPointerUp={end}
          onLostPointerCapture={end}
          onKeyUp={end}
          onBlur={end}
          aria-label={`${name} target`}
          aria-valuetext={`${value.toFixed(1)}${unit}`}
          className="block h-5 w-full min-w-20 accent-primary disabled:opacity-50"
        />
      </td>
      <td className="py-2 pl-3 text-right font-mono text-micro tabular-nums text-foreground">
        {measured === undefined ? "—" : `${value.toFixed(1)}${unit}`}
      </td>
      <td className="hidden whitespace-nowrap py-2 pl-3 text-right font-mono text-[10px] tabular-nums text-muted xl:table-cell">
        {min} … {max}
      </td>
    </tr>
  );
}

function JointsColumn({ status, live, setJoints }: Pick<DevProps, "status" | "live" | "setJoints">) {
  const headingId = useId();
  return (
    <div className="p-5">
      <Eyebrow as="h3" id={headingId}>
        Joints · lerobot units
      </Eyebrow>
      <table aria-labelledby={headingId} className="mt-3 w-full border-b border-hairline">
        <tbody>
          {JOINTS.map((name) => (
            <JointRow key={name} name={name} measured={status?.joints[name]} live={live} setJoints={setJoints} />
          ))}
        </tbody>
      </table>
      <p className="mt-2 text-ui text-muted">Dragging a slider holds the deadman, like a held key.</p>
    </div>
  );
}

export function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    navigator.clipboard.writeText(text).then(
      () => setCopied(true),
      () => setCopied(false), // No clipboard permission: the text is still there to select.
    );
  return (
    <div className="flex items-stretch border border-hairline-strong bg-background">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap px-3 py-2.5 font-mono text-micro text-foreground">{text}</code>
      <button type="button" onClick={copy} aria-label={copied ? "Copied" : `Copy: ${text}`} className={`${iconButton} w-9 shrink-0 border-l border-hairline`}>
        {copied ? <span className="font-mono text-[10px]">✓</span> : <Icon name="copy" className="size-3.5" />}
      </button>
    </div>
  );
}

/**
 * Masked like a password, but a text field outside any form: browsers offer to save a password
 * field when its form goes away (Studio remounts on join), and the token must never be stored.
 */
const MASKED = { WebkitTextSecurity: "disc" } as CSSProperties;

const linkClass = "inline-flex items-center gap-1 text-foreground/85 underline-offset-4 hover:text-foreground hover:underline";

function RunColumn({ roomId, joinWithToken }: Pick<DevProps, "roomId" | "joinWithToken">) {
  const headingId = useId();
  const tokenId = useId();
  const [token, setToken] = useState(""); // React state only: never a URL, never storage.
  const join = () => {
    if (token.trim()) joinWithToken(token.trim());
  };
  return (
    <div className="p-5">
      <Eyebrow as="h3" id={headingId}>
        Run this yourself
      </Eyebrow>
      <p className="mt-3 text-ui leading-relaxed text-foreground/80">
        Drive this arm from your own machine with a plain Python leader: the same SDK and wire protocol a physical SO-101 uses.
      </p>
      <ol className="mt-4 space-y-4">
        <li>
          <p className="mb-1.5 font-mono text-micro text-muted">1 · Install</p>
          <CopyLine text="pip install zeroruntime-teleops" />
        </li>
        <li>
          <div>
            <label htmlFor={tokenId} className="mb-1.5 block font-mono text-micro text-muted">
              2 · Paste your Zero Runtime token
            </label>
            <div className="flex">
              <input
                id={tokenId}
                type="text"
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                data-1p-ignore
                data-lpignore="true"
                style={MASKED}
                value={token}
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && join()}
                placeholder="eyJhbGciOi…"
                className="h-9 min-w-0 flex-1 border border-hairline-strong bg-background px-3 font-mono text-micro text-foreground placeholder:text-muted hover:border-foreground/25"
              />
              <button type="button" onClick={join} disabled={!token.trim()} className={`${btn.line} h-9 border-l-0 px-3 text-ui disabled:opacity-60`}>
                Join my room
              </button>
            </div>
          </div>
          <p className="mt-1.5 text-micro text-muted">
            Moves this robot into a new room on your account. Kept in memory only: never stored, never put in a URL.
          </p>
        </li>
        <li>
          <p className="mb-1.5 font-mono text-micro text-muted">3 · Run the leader, with ZERORUNTIME_AUTH_TOKEN set</p>
          <CopyLine text={`ZERORUNTIME_MEETING_ID=${roomId ?? "<roomId>"} python studio/leader.py`} />
        </li>
      </ol>
      <p className="mt-4 flex gap-4 text-ui">
        <a href={LINKS.docs} target="_blank" rel="noreferrer" className={linkClass}>
          Docs <Icon name="external" className="size-3" />
        </a>
        <a href={LINKS.github} target="_blank" rel="noreferrer" className={linkClass}>
          GitHub <Icon name="external" className="size-3" />
        </a>
      </p>
    </div>
  );
}

/** Stacked, for the mobile sheet. */
export function DevContent(props: DevProps) {
  return (
    <div className="divide-y divide-hairline">
      <LeaseColumn {...props} />
      <JointsColumn {...props} />
      <RunColumn {...props} />
    </div>
  );
}

export function DevDrawer({ name, close, ...props }: DevProps & { name: string | null; close(): void }) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={`pointer-events-auto hidden h-[min(46vh,440px)] shrink-0 flex-col lg:flex ${glass}`}>
      <header className="flex h-11 shrink-0 items-center gap-4 border-b border-hairline pl-5 pr-1">
        <h2 id={headingId} className="flex items-center gap-2 text-ui font-medium">
          <Icon name="code" className="size-4 text-muted" />
          Developer
        </h2>
        <span className="hidden font-mono text-micro text-muted xl:inline">{ROBOT_ID} · teleop v2</span>
        {name && <span className="ml-auto truncate text-ui text-muted">Signed in as <span className="text-foreground">{name}</span></span>}
        <button type="button" onClick={close} aria-label="Close the developer drawer" className={`${iconButton} size-9 ${name ? "" : "ml-auto"}`}>
          <Icon name="close" />
        </button>
      </header>
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,0.95fr)_minmax(0,1.15fr)_minmax(0,1fr)] divide-x divide-hairline">
        <div className="overflow-y-auto">
          <LeaseColumn {...props} />
        </div>
        <div className="overflow-y-auto">
          <JointsColumn {...props} />
        </div>
        <div className="overflow-y-auto">
          <RunColumn {...props} />
        </div>
      </div>
    </section>
  );
}
