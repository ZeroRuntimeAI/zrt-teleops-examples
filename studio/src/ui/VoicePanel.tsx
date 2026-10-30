"use client";
/** Voice mode's screens: the dock strip and language switch, the level meter, and the transcript with the agent's tool calls. */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Eyebrow, Icon } from "./ui";
import type { Language, Voice } from "./useVoice";
import type { ToolRow, TranscriptRow, VoiceState } from "./voiceEvents";

/** Tailwind's `lg`: the desktop dock and rail show, the touch dock hides. Never true on the server. */
export function useWide(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia("(min-width: 1024px)");
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    () => window.matchMedia("(min-width: 1024px)").matches,
    () => false,
  );
}

const LANGUAGES: readonly { code: Language; label: string; name: string }[] = [
  { code: "en", label: "EN", name: "English" },
  { code: "hi", label: "HI", name: "Hindi" },
];

/** English or Hindi for the agent. Sent with the request that brings it in, so it is fixed once Voice is on. */
export function LanguageSwitch({ voice }: { voice: Voice }) {
  return (
    <div role="group" aria-label="Voice language" className="flex items-center self-center border border-hairline-strong">
      {LANGUAGES.map(({ code, label, name }) => (
        <button
          key={code}
          type="button"
          aria-pressed={voice.language === code}
          disabled={voice.active || !voice.available}
          onClick={() => voice.setLanguage(code)}
          className={`h-6 px-1.5 font-mono text-micro transition-colors duration-[var(--duration-fast)] disabled:opacity-50 ${
            voice.language === code ? "bg-hairline-strong text-foreground" : "text-muted hover:text-foreground"
          }`}
        >
          {label}
          <span className="sr-only"> ({name})</span>
        </button>
      ))}
    </div>
  );
}

const BARS = 14;
const LEVEL_GAIN = 4;
const METER_MS = 66;

/** How loud the agent's audio is right now, from a real `AnalyserNode` on its track. Nothing without a track. */
export function LevelMeter({ track }: { track: MediaStreamTrack | null }) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!track) return;
    const ctx = new AudioContext();
    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser); // Not to the speakers: the room element already plays it.
    void ctx.resume();
    const samples = new Uint8Array(analyser.fftSize);
    let frame = 0;
    let last = 0;
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (now - last < METER_MS) return;
      last = now;
      analyser.getByteTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, v) => sum + ((v - 128) / 128) ** 2, 0) / samples.length);
      setLevel(Math.min(1, rms * LEVEL_GAIN));
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      source.disconnect();
      void ctx.close();
      setLevel(0);
    };
  }, [track]);
  if (!track) return null;
  return (
    <span data-testid="voice-level" aria-hidden className="flex h-4 items-center gap-0.5">
      {Array.from({ length: BARS }, (_, i) => (
        <span key={i} className={`h-full w-0.5 ${(i + 1) / BARS <= level ? "bg-primary" : "bg-hairline-strong"}`} />
      ))}
    </span>
  );
}

const PHASE_WORDS = { idle: "Agent ready", listening: "Listening", thinking: "Thinking", speaking: "Speaking" } as const;

/** One line in the dock: waiting in line, the agent's state and level, or why Voice isn't on. */
export function VoiceStrip({ voice, className = "" }: { voice: Voice; className?: string }) {
  const { agent, position } = voice.state;
  if (voice.error) {
    return (
      <p role="alert" className={`flex items-start gap-2 text-ui text-foreground ${className}`}>
        <Icon name="alert" className="mt-0.5 size-4 shrink-0" />
        {voice.error}
      </p>
    );
  }
  if (agent === "off") return null;
  if (agent === "queued") {
    return (
      <p role="status" className={`flex flex-wrap items-center gap-x-2 text-ui ${className}`}>
        <span>
          <strong className="font-semibold">Voice is busy — you&apos;re #{position}.</strong> <span className="text-muted">Keep driving while you wait.</span>
        </span>
        <button type="button" onClick={voice.off} className="text-foreground/85 underline underline-offset-4 hover:text-foreground">
          Leave queue
        </button>
      </p>
    );
  }
  return (
    <div className={`flex items-center gap-3 text-ui ${className}`}>
      <Icon name="mic" className="size-4 shrink-0 text-primary" />
      <p role="status" className="font-medium">
        {PHASE_WORDS[agent]}
      </p>
      <LevelMeter track={voice.track} />
      <span className="hidden text-muted xl:inline">Press a drive key to take over</span>
    </div>
  );
}

const clock = (at: number) => new Date(at).toLocaleTimeString("en-GB", { hour12: false });

function Line({ row }: { row: TranscriptRow }) {
  return (
    <li className="py-2">
      <p className="font-mono text-micro text-muted">
        {row.who === "you" ? "You" : "Zero Runtime agent"}
        {row.at !== undefined && <> · {clock(row.at)}</>}
      </p>
      <p className={`mt-0.5 text-sm leading-snug ${row.who === "you" ? "text-foreground" : "text-foreground/85"}`}>{row.text}</p>
    </li>
  );
}

/** A tool call. The executor line is the agent's own label, shown as it arrived. */
export function ToolCard({ tool }: { tool: ToolRow }) {
  // Words and an icon, in the foreground colour: the status colours belong to the robot's own state.
  const status = tool.ok === undefined ? null : tool.ok ? "done" : "failed";
  return (
    <div className="border border-hairline-strong p-3">
      <p className="flex items-baseline justify-between gap-3 font-mono text-ui">
        <span className="min-w-0 break-words">
          {tool.name}({tool.args})
        </span>
        {status && (
          <span className="flex shrink-0 items-center gap-1 text-micro uppercase tracking-[0.14em] text-foreground">
            <Icon name={tool.ok ? "check" : "alert"} className="size-3" />
            {status}
          </span>
        )}
      </p>
      {tool.executor && <p className="mt-2 font-mono text-micro leading-relaxed text-muted">{tool.executor}</p>}
    </div>
  );
}

const WAITING = "You're in line for a voice agent. Keep driving with the keyboard; the transcript starts when an agent joins.";

/** The transcript and tool calls: under the activity log in the rail and in the touch Activity sheet. */
export function VoiceTranscript({ voice, headingId, className = "" }: { voice: Voice; headingId: string; className?: string }) {
  const { agent, transcript, tools } = voice.state;
  const scroller = useRef<HTMLDivElement>(null);
  // The newest line stays in view.
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [transcript.length, tools.length]);
  if (agent === "off" && !transcript.length && !tools.length) return null;
  return (
    <section aria-labelledby={headingId} className={`border-t border-hairline px-5 py-4 ${className}`}>
      <div className="flex items-baseline justify-between">
        <Eyebrow as="h2" id={headingId}>
          Voice transcript
        </Eyebrow>
        <span className="font-mono text-micro text-muted">{voice.language.toUpperCase()}</span>
      </div>
      {!transcript.length && !tools.length && <p className="mt-2 text-ui leading-relaxed text-muted">{agent === "queued" ? WAITING : "Say what you want the arm to do."}</p>}
      <div ref={scroller} className="mt-1 max-h-80 overflow-y-auto">
        {transcript.length > 0 && (
          <ol className="divide-y divide-hairline">
            {transcript.map((row, i) => (
              <Line key={i} row={row} />
            ))}
          </ol>
        )}
        {tools.length > 0 && (
          <div className="mt-3 space-y-2" role="group" aria-label="Tool calls">
            {tools.map((tool, i) => (
              <ToolCard key={i} tool={tool} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

/** The newest tool call, for the touch dock, where the rail is not on screen. */
export function LatestTool({ state }: { state: VoiceState }) {
  const tool = state.tools.at(-1);
  return tool ? <ToolCard tool={tool} /> : null;
}
