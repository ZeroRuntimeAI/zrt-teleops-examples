"use client";
/**
 * Owns one Studio session: the sim files, the session (`POST /api/session`, or offline), the room
 * transport and the robot worker. Offline mode (`NEXT_PUBLIC_STUDIO_OFFLINE=1`) skips the session
 * and the room: roomId "offline", five minutes, and an `OfflineTransport`. With a pasted `token`
 * the room is created in that account instead (developer drawer). One hook instance is one
 * session: to start another, remount it (Workspace keys it).
 */
import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import type { FromWorker, RobotStatus, ToWorker, WasmModule } from "../robot/protocol";
import type { Joints } from "../sim/jointMap";
import { appendLog, shown, type LogEntry, type LogEvent } from "./ActivityLog";
import { RoomTransport } from "../room/roomTransport";
import { OfflineTransport, type Transport } from "../room/transport";
import type { JogInput } from "../sim/jog";
import { installTestHooks } from "./testHooks";

export type Phase = "loading" | "ready" | "disconnected" | "ended" | "error";

/** What failed, for the error screen's copy: the browser, the robot's files and engine, or the room. */
export type ErrorKind = "webgl" | "wasm" | "load" | "room";
export type RobotError = { kind: ErrorKind; message: string };

/** Bytes (or files) done of total; total is 0 when unknown. */
export type Progress = { loaded: number; total: number };
export type LoadProgress = { files: Progress } & Partial<Record<WasmModule, Progress>>;

export type Robot = {
  status: RobotStatus | null;
  phase: Phase;
  error?: RobotError;
  /** The robot's own downloads while `loading`. */
  progress: LoadProgress;
  /** Lease and safe-state events and session milestones, newest first. */
  log: LogEntry[];
  jog(j: JogInput): void;
  /** Developer-drawer sliders: `held` while dragging. */
  setJoints(joints: Partial<Joints>, held: boolean): void;
  /** Something outside the hook (the 3D stage) can't go on: the same as a failed boot. */
  fail(e: RobotError): void;
  /** The local e-stop, and the same to the voice agent (`ROBOT_CTRL`). */
  stop(): void;
  reset(): void;
  handBack(): void;
  enableMic(on: boolean): Promise<void>;
  roomId?: string;
  /** This tab's participant id: the worker's `selfId`. */
  selfId?: string;
  /** When the session ends, in epoch ms. */
  expiresAt?: number;
  /** The scene layout seed, for the stage's own copy of the model (the front camera's jitter). */
  seed: number | null;
  /** `public/sim`, keyed by path relative to `scene.xml`, once fetched. */
  files: Record<string, Uint8Array> | null;
  /** The latest worker `poses`, updated outside React at up to 60 Hz. */
  poses: RefObject<Float64Array | null>;
  /** The measured joints that came with those poses, in `JOINTS` order: what the servo sound follows. */
  jointAngles: RefObject<Float64Array | null>;
  /** The 640×480 front-camera canvas the room publishes as the webcam. */
  frontCanvas: HTMLCanvasElement | null;
  /** A worker is running, so Stop reaches it: from boot on, whatever the phase. */
  canStop: boolean;
  /** The server has a voice agent to dispatch (`/api/session`); offline, only a test hook turns it on. */
  voiceAvailable: boolean;
  /** The room, once joined: the voice panel listens and publishes through it. */
  transport: Transport | null;
  /** Add an app event to the activity log. */
  note(event: LogEvent): void;
  /** The session is over now (the voice service says the room is ending): leave the room. */
  end(): void;
  /** A non-fatal robot error, until dismissed. */
  notice?: string;
  dismissNotice(): void;
};

/** The pubsub topic the voice agent listens on for the page's controls. */
export const ROBOT_CTRL = "ROBOT_CTRL";
const STOP_MESSAGE = JSON.stringify({ cmd: "stop" });

const OFFLINE = process.env.NEXT_PUBLIC_STUDIO_OFFLINE === "1";
const OFFLINE_SESSION_MS = 300_000;
const CAMERA = { width: 640, height: 480 } as const;

const ROOMS_API = "https://api.videosdk.live/v2/rooms";

/** No `expiresAt`: a room in the visitor's own account runs until its token does. */
type Session = { roomId: string; participantId: string; token: string; expiresAt?: number; voiceAvailable: boolean };

class StudioError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
  ) {
    super(message);
  }
}
const asRobotError = (e: unknown, kind: ErrorKind = "load"): RobotError =>
  e instanceof StudioError ? { kind: e.kind, message: e.message } : { kind, message: errorText(e) };

/** Whether this browser gives a WebGL2 context; the probe context is released at once. */
export function hasWebGL2(): boolean {
  const gl = document.createElement("canvas").getContext("webgl2");
  gl?.getExtension("WEBGL_lose_context")?.loseContext();
  return gl !== null;
}

/** Fail before downloading anything if this browser can't run the stage or the sim. */
function checkBrowser(): void {
  if (typeof WebAssembly !== "object") throw new StudioError("wasm", "WebAssembly is not available in this browser.");
  if (!hasWebGL2()) throw new StudioError("webgl", "webgl2: canvas.getContext returned null");
}

const newSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** `public/sim`, keyed by path; `onFile` counts each one that arrives. */
export async function fetchFiles(
  paths: readonly string[],
  signal: AbortSignal,
  onFile: () => void = () => {},
): Promise<Record<string, Uint8Array>> {
  const entries = await Promise.all(
    paths.map(async (path) => {
      const res = await fetch(`/sim/${path}`, { signal });
      if (!res.ok) throw new Error(`Couldn't load ${path} (HTTP ${res.status}).`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      onFile();
      return [path, bytes] as const;
    }),
  );
  return Object.fromEntries(entries);
}

/**
 * A room in the pasted token's account, created from this tab: the token goes only to the
 * VideoSDK API, raw (no "Bearer"), and is never stored.
 */
async function openOwnSession(token: string, signal: AbortSignal): Promise<Session> {
  let res: Response;
  try {
    res = await fetch(ROOMS_API, { method: "POST", headers: { Authorization: token, "Content-Type": "application/json" }, body: "{}", signal });
  } catch (e) {
    throw new StudioError("room", `Couldn't reach the rooms API (${errorText(e)}).`);
  }
  const body: Record<string, unknown> = await res.json().catch(() => ({}));
  if (!res.ok) {
    const why = typeof body.error === "string" ? body.error : typeof body.message === "string" ? body.message : `HTTP ${res.status}`;
    throw new StudioError("room", `Couldn't create a room with that token (${why}).`);
  }
  if (typeof body.roomId !== "string") throw new StudioError("room", "Couldn't create a room with that token (unexpected response).");
  const participantId = `studio-robot-${crypto.randomUUID().slice(0, 8)}`;
  // Unknown to the server, so /api/voice refuses the room: never offer Voice where it cannot work.
  return { roomId: body.roomId, participantId, token, voiceAvailable: false };
}

async function openSession(signal: AbortSignal, ownToken: string | undefined): Promise<Session> {
  if (ownToken) return openOwnSession(ownToken, signal);
  if (OFFLINE) {
    return { roomId: "offline", participantId: "studio-robot-offline", token: "", expiresAt: Date.now() + OFFLINE_SESSION_MS, voiceAvailable: false };
  }
  const res = await fetch("/api/session", { method: "POST", signal });
  const body: Record<string, unknown> = await res.json().catch(() => ({}));
  if (res.status === 429) {
    const minutes = Math.max(1, Math.ceil(Number(body.retryAfterS) / 60) || 1);
    throw new StudioError("room", `Too many sessions from this network. Try again in ${minutes} min.`);
  }
  if (!res.ok) throw new StudioError("room", `Couldn't start a session (${typeof body.error === "string" ? body.error : res.status}).`);
  const { roomId, participantId, token, expiresAt, voiceAvailable } = body;
  if (typeof roomId !== "string" || typeof participantId !== "string" || typeof token !== "string" || !Number.isFinite(expiresAt)) {
    throw new StudioError("room", "Couldn't start a session (unexpected response).");
  }
  return { roomId, participantId, token, expiresAt: expiresAt as number, voiceAvailable: voiceAvailable === true };
}

function makeFrontCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = CAMERA.width;
  canvas.height = CAMERA.height;
  // A context and a first frame before the room captures it.
  canvas.getContext("2d")?.fillRect(0, 0, CAMERA.width, CAMERA.height);
  return canvas;
}

/** js-sdk's INVALID_TOKEN: the room token ran out, which is the session ending, not a lost room. */
const TOKEN_EXPIRED = /^error 4002\b/;

export function useRobot(simFiles: readonly string[], token?: string): Robot {
  const [status, setStatus] = useState<RobotStatus | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [error, setError] = useState<RobotError>();
  const [progress, setProgress] = useState<LoadProgress>({ files: { loaded: 0, total: simFiles.length } });
  const [log, setLog] = useState<LogEntry[]>([]);
  const [session, setSession] = useState<Session>();
  const [expiresAt, setExpiresAt] = useState<number>();
  const [seed, setSeed] = useState<number | null>(null);
  const [files, setFiles] = useState<Record<string, Uint8Array> | null>(null);
  const [frontCanvas, setFrontCanvas] = useState<HTMLCanvasElement | null>(null);
  const [canStop, setCanStop] = useState(false);
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const [notice, setNotice] = useState<string>();
  const [transport, setTransport] = useState<Transport | null>(null);
  const statusRef = useRef<RobotStatus | null>(null);
  const poses = useRef<Float64Array | null>(null);
  const jointAngles = useRef<Float64Array | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const transportRef = useRef<Transport | null>(null);
  const fatalRef = useRef<(e: RobotError) => void>(() => {});
  const logId = useRef(0);
  const pushLog = useCallback((event: LogEvent) => {
    const entry = { id: (logId.current += 1), at: Date.now(), event };
    setLog((rows) => appendLog(rows, entry));
  }, []);

  useEffect(() => {
    let disposed = false;
    let worker: Worker | null = null;
    let transport: Transport | null = null;
    let ready = false;
    const abort = new AbortController();
    /**
     * The robot can't go on: stop it, end the worker and leave the room, so no remote operator
     * drives an arm this tab can no longer stop.
     */
    const fatal = (e: RobotError) => {
      if (disposed) return;
      if (worker) {
        worker.postMessage({ t: "stop" } satisfies ToWorker);
        worker.terminate();
      }
      worker = null;
      workerRef.current = null;
      void transport?.leave();
      transport = null; // transportRef keeps it, for the test hook
      setCanStop(false);
      setError(e);
      setPhase("error");
    };
    fatalRef.current = fatal;
    let inBox = 0;
    const onStatus = (next: RobotStatus) => {
      statusRef.current = next;
      setStatus(next);
      // Only a cube that lands is news; a Reset that empties the box is logged as the reset.
      if (next.cubesInBox.length > inBox) pushLog({ op: "app", what: "cube", color: next.cubesInBox.at(-1), count: next.cubesInBox.length });
      inBox = next.cubesInBox.length;
    };
    const onEvent = (event: LogEvent) => {
      if (shown(event)) pushLog(event);
      // The core holds on a lost transport (safe state HOLDING, reason transport_lost) and says so
      // with this event: whoever reported it (the room, or the test hook), the session is over.
      if (event.op === "ev" && event.kind === "disconnected") setPhase((p) => (p === "ready" ? "disconnected" : p));
    };
    /** The room said it is gone: a token that ran out ends the session, anything else is a lost room. */
    const onDisconnected = (why: string) => {
      if (disposed) return;
      const ended = TOKEN_EXPIRED.test(why);
      setPhase((p) => (p === "ready" ? (ended ? "ended" : "disconnected") : p));
    };
    const onMessage = ({ data: m }: MessageEvent<FromWorker>) => {
      switch (m.t) {
        case "ready":
          ready = true;
          return setPhase((p) => (p === "loading" ? "ready" : p));
        case "send":
          return transport?.send(m.msg);
        case "poses":
          poses.current = m.poses;
          jointAngles.current = m.joints;
          return;
        case "status":
          return onStatus(m.status);
        case "event":
          return onEvent(m.event as LogEvent);
        case "progress":
          return setProgress((p) => ({ ...p, [m.module]: { loaded: m.loaded, total: m.total } }));
        case "error":
          // After boot an error is one dropped message or one stopped timer: the robot runs on,
          // and its own safety still trips on a dead loop. Before boot there is no robot.
          return ready ? setNotice(m.message) : fatal({ kind: "load", message: m.message });
      }
    };

    const start = async () => {
      checkBrowser();
      const canvas = makeFrontCanvas();
      setFrontCanvas(canvas);
      const onFile = () => setProgress((p) => ({ ...p, files: { ...p.files, loaded: p.files.loaded + 1 } }));
      const [loaded, s] = await Promise.all([fetchFiles(simFiles, abort.signal, onFile), openSession(abort.signal, token)]);
      // Join with exactly the returned room and participant: the token is bound to them.
      const t: Transport =
        OFFLINE && !token
          ? new OfflineTransport()
          : await RoomTransport.join({
              roomId: s.roomId,
              token: s.token,
              participantId: s.participantId,
              frontCanvas: canvas,
              onDisconnected, // The worker hears it too, and its status reads DISCONNECTED.
            }).catch((e: unknown) => {
              throw new StudioError("room", `Couldn't join room ${s.roomId} (${errorText(e)}).`);
            });
      if (disposed) return void t.leave();
      transport = t;
      transportRef.current = t;
      setTransport(t);
      worker = new Worker(new URL("../robot/worker.ts", import.meta.url), { type: "module" });
      workerRef.current = worker;
      worker.onmessage = onMessage;
      worker.onerror = (e) => fatal({ kind: "load", message: e.message || "The robot worker failed." });
      t.attach(worker);
      setCanStop(true);
      const first = newSeed();
      setSeed(first);
      setFiles(loaded);
      setSession(s);
      setVoiceAvailable(s.voiceAvailable);
      setExpiresAt(s.expiresAt);
      pushLog({ op: "app", what: "start", roomId: s.roomId });
      worker.postMessage({ t: "init", files: loaded, selfId: s.participantId, seed: first } satisfies ToWorker);
    };
    // Deferred a tick: React's dev double-mount cancels it before a session (a real room) is opened.
    const timer = setTimeout(() => start().catch((e) => fatal(asRobotError(e))), 0);
    return () => {
      disposed = true;
      clearTimeout(timer);
      abort.abort();
      worker?.terminate();
      void transport?.leave();
      workerRef.current = null;
      transportRef.current = null;
    };
  }, [simFiles, token, pushLog]);

  // At `expiresAt` the session is over: leave the room, before the token itself expires.
  const end = useCallback(() => {
    if (phase !== "ready") return;
    setPhase("ended");
    pushLog({ op: "app", what: "ended" });
    void transportRef.current?.leave();
  }, [phase, pushLog]);
  useEffect(() => {
    if (expiresAt === undefined || phase !== "ready") return;
    const id = setTimeout(end, Math.max(0, expiresAt - Date.now()));
    return () => clearTimeout(id);
  }, [expiresAt, phase, end]);

  const post = useCallback((m: ToWorker) => workerRef.current?.postMessage(m), []);
  const jog = useCallback((j: JogInput) => post({ t: "jog", jog: j }), [post]);
  const stop = useCallback(() => {
    post({ t: "stop" });
    transportRef.current?.publish(ROBOT_CTRL, STOP_MESSAGE);
  }, [post]);
  const handBack = useCallback(() => post({ t: "handBack" }), [post]);
  const setJoints = useCallback((joints: Partial<Joints>, held: boolean) => post({ t: "setJoints", joints, held }), [post]);
  const reset = useCallback(() => {
    const next = newSeed();
    setSeed(next);
    pushLog({ op: "app", what: "reset" });
    post({ t: "reset", seed: next });
  }, [post, pushLog]);
  const fail = useCallback((e: RobotError) => fatalRef.current(e), []);
  const dismissNotice = useCallback(() => setNotice(undefined), []);
  const enableMic = useCallback(async (on: boolean) => transportRef.current?.enableMic(on), []);

  useEffect(
    () =>
      installTestHooks({
        status: () => statusRef.current,
        gripperZ: () => statusRef.current?.gripperPos[2] ?? NaN,
        setVoiceAvailable,
        expireIn: (ms) => setExpiresAt(Date.now() + ms),
        simulateDisconnect: () => workerRef.current?.postMessage({ t: "connection", connected: false, why: "simulated" } satisfies ToWorker),
        transport: () => (transportRef.current instanceof OfflineTransport ? transportRef.current : null),
      }),
    [],
  );

  return {
    status,
    phase,
    error,
    progress,
    log,
    jog,
    setJoints,
    fail,
    stop,
    reset,
    handBack,
    enableMic,
    roomId: session?.roomId,
    selfId: session?.participantId,
    expiresAt,
    seed,
    files,
    poses,
    jointAngles,
    frontCanvas,
    canStop,
    voiceAvailable,
    transport,
    note: pushLog,
    end,
    notice,
    dismissNotice,
  };
}
