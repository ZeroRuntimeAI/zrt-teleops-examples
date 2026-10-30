/**
 * The main-thread bridge between the robot worker and a VideoSDK room. WebRTC cannot run in a
 * Worker, so this owns the js-sdk meeting: data lanes for teleop frames, pubSub for the
 * `teleop-v2-*` control plane, participant and connection events, and the front camera as the
 * webcam. The Rust teleop SDK peers use the same SCTP labels, topics and wire formats.
 */
import type { AgentParticipant, Meeting, VideoSDK } from "@videosdk.live/js-sdk";
import type { OutboundMsg, ToWorker } from "../robot/protocol";
import { playTrack } from "./agentAudio";
import { frontStream } from "./cameraTrack";
import type { AgentSignal, Transport } from "./transport";

const CTL_TOPIC = "teleop-v2-ctl";
/** `ctl` carries the lease and e-stop: without it there is no teleop. `rec` and `stats` are best effort. */
const TELEOP_TOPICS = [CTL_TOPIC, "teleop-v2-rec", "teleop-v2-stats"] as const;
/** js-sdk 1.2.1 keeps every received data message for the life of the meeting. */
const MESSAGE_LOG_CLEAR_MS = 10_000;
/**
 * The js-sdk `error` event codes that mean the room itself is unusable. Every other `error` event
 * is a failed action (a send, the mic, a track) while the room is up, so it is logged and
 * otherwise ignored: `meeting-left` stays the main loss signal. From js-sdk 1.2.1, `Errors` in
 * constants.d.ts and the emit sites in videosdk.js:
 * - 3044 ERROR_MEETING_MEDIA_CONNECTION_FAILED: emitted when the media transport's state is "failed".
 * - 3047 ERROR_UNABLE_TO_JOIN_MEETING: emitted when joining the meeting fails.
 * - 4001-4007 and 4009, the server's refusals of this participant: INVALID_API_KEY, INVALID_TOKEN,
 *   INVALID_MEETING_ID, INVALID_PARTICIPANT_ID, DUPLICATE_PARTICIPANT, ACCOUNT_DEACTIVATED,
 *   ACCOUNT_DISCONTINUED, MAX_PARTCIPANT_REACHED. Passed on from the server's `error`
 *   notification, so whether it sends each of them is not verified.
 * Left out on purpose: 4008 INVALID_PERMISSIONS and 4010 MAX_SPEAKER_REACHED (per action), 3070
 * ERROR_SEND_FAILED, and the mic, webcam and track errors in the 3011-3034 and 3049-3063 ranges.
 */
const ROOM_FATAL_ERRORS: ReadonlySet<number> = new Set([3044, 3047, 4001, 4002, 4003, 4004, 4005, 4006, 4007, 4009]);
/** A non-fatal `error` code is logged at most this often. */
const ERROR_WARN_EVERY_MS = 5_000;
const ROBOT_NAME = "Studio robot";

/** js-sdk's `Meeting`, plus the public `messages` log that its typings leave out. */
export type RoomMeeting = Meeting & { messages: unknown[] };
type Sdk = Pick<typeof VideoSDK, "config" | "initMeeting">;
type Subscriber = (message: string, from: string) => void;
type AgentListener = (signal: AgentSignal) => void;

/** The voice agent in the room, with what is replayed to a listener that comes late. */
type AgentSlot = { participant: AgentParticipant; state: string | null; track: MediaStreamTrack | null; stopPlayback: () => void; detach: () => void };

export interface JoinOptions {
  roomId: string;
  token: string;
  participantId: string;
  /** The sim's front-camera canvas: published as the room webcam. */
  frontCanvas: HTMLCanvasElement;
  /** The room is gone (the meeting was left, or js-sdk reported an error). Not called for our own `leave()`. */
  onDisconnected: (why: string) => void;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class RoomTransport implements Transport {
  private worker: Worker | null = null;
  private dropped = 0;
  /** The webcam stream id, once up. Replayed to a worker that attaches later. */
  private front: string | null = null;
  /** Why the room is gone, once it is. Replayed to a worker that attaches later. */
  private lostWhy: string | null = null;
  /** When each non-fatal `error` code was last logged. */
  private readonly warnedAt = new Map<number, number>();
  private agent: AgentSlot | null = null;
  private readonly agentListeners = new Set<AgentListener>();
  private readonly selfId: string;
  private readonly clearLog: ReturnType<typeof setInterval>;
  private readonly unlisten: () => void;

  /** Listens and starts the log timer at once, so nothing during `join()` is missed. */
  private constructor(
    readonly meeting: RoomMeeting,
    private readonly onDisconnected: (why: string) => void,
  ) {
    this.selfId = meeting.localParticipant.id;
    this.unlisten = this.listen();
    // Read `meeting.messages` afresh each time: js-sdk replaces the array on join and on leave.
    this.clearLog = setInterval(() => {
      meeting.messages.length = 0;
    }, MESSAGE_LOG_CLEAR_MS);
  }

  /** Join the room as the Studio robot, publishing `frontCanvas` as its webcam. */
  static async join(opts: JoinOptions, sdk?: Sdk): Promise<RoomTransport> {
    // Imported here, not at the top: js-sdk touches `self` as it loads, which breaks server rendering.
    const videoSdk = sdk ?? (await import("@videosdk.live/js-sdk")).VideoSDK;
    videoSdk.config(opts.token);
    const meeting = videoSdk.initMeeting({
      meetingId: opts.roomId,
      participantId: opts.participantId,
      name: ROBOT_NAME,
      micEnabled: false,
      webcamEnabled: true,
      customCameraVideoTrack: frontStream(opts.frontCanvas),
      multiStream: false,
      mode: "SEND_AND_RECV",
    }) as RoomMeeting;
    return RoomTransport.connect(meeting, opts.onDisconnected);
  }

  /** Join `meeting` and subscribe to the teleop topics. Split from `join` so a test can pass a fake meeting. */
  static async connect(meeting: RoomMeeting, onDisconnected: (why: string) => void): Promise<RoomTransport> {
    const transport = new RoomTransport(meeting, onDisconnected);
    try {
      // Listen before join(): `meeting-joined` could come before join() returns.
      const joined = transport.untilJoined();
      await Promise.all([joined, meeting.join()]);
      await transport.subscribeTeleop();
      transport.adoptWebcam();
      transport.adoptAgent();
    } catch (e) {
      // Cleanup only: the failure that matters is the one rethrown.
      await transport.leave().catch(() => {});
      throw e;
    }
    return transport;
  }

  /** Number of outbound messages that could not be sent, such as data sent before the lazy channel opens. */
  get droppedLocal(): number {
    return this.dropped;
  }

  /** Give the worker the room's inbound traffic, and replay what it missed: the webcam and a lost room. */
  attach(worker: Worker): void {
    this.worker = worker;
    if (this.front !== null) this.post({ t: "producers", map: { front: this.front } });
    if (this.lostWhy !== null) this.post({ t: "connection", connected: false, why: this.lostWhy });
  }

  send(msg: OutboundMsg): void {
    if (msg.kind === "data") void this.sendData(msg.bytes, msg.reliable);
    else void this.publishTo(msg.topic, msg.message, msg.persist, msg.sendOnly);
  }

  publish(topic: string, message: string): void {
    void this.publishTo(topic, message, false);
  }

  subscribe(topic: string, cb: Subscriber): void {
    this.subscribeTopic(topic, cb).catch((e) => console.warn(`[RoomTransport] cannot subscribe to ${topic}`, e));
  }

  async enableMic(on: boolean): Promise<void> {
    await (on ? this.meeting.unmuteMic() : this.meeting.muteMic());
  }

  /** The agent participant's state, transcript lines and audio track, replaying what is already known. */
  onAgent(cb: AgentListener): () => void {
    this.agentListeners.add(cb);
    const a = this.agent;
    if (a) {
      cb({ t: "joined", id: a.participant.id });
      if (a.state !== null) cb({ t: "state", state: a.state });
      if (a.track) cb({ t: "audio", track: a.track });
    }
    return () => void this.agentListeners.delete(cb);
  }

  /** Leave the room. The worker is told the connection is gone; `onDisconnected` is not called. */
  async leave(): Promise<void> {
    clearInterval(this.clearLog);
    this.unlisten();
    this.detachAgent();
    this.lose("left", false);
    await this.meeting.leave();
  }

  private post(m: ToWorker): void {
    this.worker?.postMessage(m);
  }

  /** The room is gone. Reported once: the first cause wins. */
  private lose(why: string, notify: boolean): void {
    if (this.lostWhy !== null) return;
    this.lostWhy = why;
    this.post({ t: "connection", connected: false, why });
    if (notify) this.onDisconnected(why);
  }

  /** A failed action, not a lost room: logged, but a burst of the same code (such as sends) only once. */
  private warnNonFatal(code: number, message: string): void {
    const now = Date.now();
    const last = this.warnedAt.get(code);
    if (last !== undefined && now - last < ERROR_WARN_EVERY_MS) return;
    this.warnedAt.set(code, now);
    console.warn(`[RoomTransport] js-sdk error ${code}: ${message}`);
  }

  /** Meeting and webcam events; returns the function that removes them. */
  private listen(): () => void {
    const { meeting } = this;
    const local = meeting.localParticipant;
    const onData = ({ payload, from }: { payload: Uint8Array | string; from: string }) => {
      // Text is js-sdk chat, not teleop.
      if (payload instanceof Uint8Array) this.post({ t: "data", from, bytes: payload });
    };
    const onLeft = ({ id }: { id: string }) => {
      this.post({ t: "left", id });
      if (this.agent?.participant.id === id) this.detachAgent();
    };
    const onJoined = (p: { isAgent?: boolean }) => p.isAgent && this.attachAgent(p as AgentParticipant);
    const onMeetingLeft = (reason?: { message?: string }) => this.lose(reason?.message || "meeting-left", true);
    const onError = ({ code, message }: { code: number; message: string }) => {
      if (ROOM_FATAL_ERRORS.has(code)) this.lose(`error ${code}: ${message}`, true);
      else this.warnNonFatal(code, message);
    };
    const onStream = ({ id, kind }: { id: string; kind: string }) => {
      if (kind === "video") this.setFront(id);
    };
    meeting.on("data", onData);
    meeting.on("participant-left", onLeft);
    meeting.on("participant-joined", onJoined);
    meeting.on("meeting-left", onMeetingLeft);
    meeting.on("error", onError);
    local.on("stream-enabled", onStream);
    return () => {
      meeting.off("data", onData);
      meeting.off("participant-left", onLeft);
      meeting.off("participant-joined", onJoined);
      meeting.off("meeting-left", onMeetingLeft);
      meeting.off("error", onError);
      local.off("stream-enabled", onStream);
    };
  }

  /**
   * A stream that came up during `join()` may have fired before anyone attached. A local stream's
   * id is its producer id (js-sdk builds `Stream` from the producer), which is what the Follower
   * announces for the `front` track.
   */
  private adoptWebcam(): void {
    for (const stream of this.meeting.localParticipant.streams.values()) {
      if (stream.kind === "video") this.setFront(stream.id);
    }
  }

  /** An agent that was already in the room when this tab joined. */
  private adoptAgent(): void {
    for (const p of this.meeting.participants.values()) {
      if ((p as { isAgent?: boolean }).isAgent) this.attachAgent(p as AgentParticipant);
    }
  }

  private emitAgent(signal: AgentSignal): void {
    this.agentListeners.forEach((cb) => cb(signal));
  }

  private attachAgent(participant: AgentParticipant): void {
    if (this.agent?.participant === participant) return;
    this.detachAgent();
    const slot: AgentSlot = { participant, state: null, track: null, stopPlayback: () => {}, detach: () => {} };
    this.agent = slot;
    const setTrack = (track: MediaStreamTrack | null) => {
      slot.stopPlayback();
      slot.track = track;
      slot.stopPlayback = track ? playTrack(track) : () => {};
      this.emitAgent({ t: "audio", track });
    };
    const onState = (state: string) => {
      slot.state = state;
      this.emitAgent({ t: "state", state });
    };
    // The payload comes off the wire: check each field before it reaches the UI.
    const onSaid = (data: { segment?: { text?: unknown; timestamp?: unknown; type?: unknown }; participant?: { id?: unknown; isAgent?: unknown } } | undefined) => {
      const { segment, participant: speaker } = data ?? {};
      if (typeof segment?.text !== "string") return;
      if (typeof segment.type === "string" && /^(inte?rim|partial)/i.test(segment.type)) return;
      const who = speaker?.isAgent === true ? "agent" : speaker?.id === this.selfId ? "you" : null;
      if (who) this.emitAgent({ t: "said", who, text: segment.text, at: typeof segment.timestamp === "number" ? segment.timestamp : undefined });
    };
    const onStream = (stream: { kind: string; track: MediaStreamTrack }) => stream.kind === "audio" && setTrack(stream.track);
    const onStreamOff = (stream: { kind: string }) => stream.kind === "audio" && setTrack(null);
    participant.on("agent-state-changed", onState);
    participant.on("agent-transcription-received", onSaid);
    participant.on("stream-enabled", onStream);
    participant.on("stream-disabled", onStreamOff);
    slot.detach = () => {
      participant.off("agent-state-changed", onState);
      participant.off("agent-transcription-received", onSaid);
      participant.off("stream-enabled", onStream);
      participant.off("stream-disabled", onStreamOff);
      slot.stopPlayback();
    };
    this.emitAgent({ t: "joined", id: participant.id });
    for (const stream of participant.streams.values()) onStream(stream);
  }

  private detachAgent(): void {
    const slot = this.agent;
    if (!slot) return;
    this.agent = null;
    slot.detach();
    if (slot.track) this.emitAgent({ t: "audio", track: null });
    this.emitAgent({ t: "left" });
  }

  private setFront(id: string): void {
    if (this.front === id) return;
    this.front = id;
    this.post({ t: "producers", map: { front: id } });
  }

  /**
   * js-sdk 1.2.1's `join()` resolves once the server acks the entry request, before the room is
   * joined (videosdk.js `requestEntry`); pubSub refuses until `meeting-joined`. Rejects if the
   * room is lost first.
   */
  private untilJoined(): Promise<void> {
    const { meeting } = this;
    return new Promise((resolve, reject) => {
      const stop = () => {
        meeting.off("meeting-joined", onJoined);
        meeting.off("meeting-left", onLeft);
        meeting.off("error", onError);
      };
      const onJoined = () => {
        stop();
        resolve();
      };
      const onLeft = (reason?: { message?: string }) => {
        stop();
        reject(new Error(reason?.message || "meeting-left"));
      };
      const onError = ({ code, message }: { code: number; message: string }) => {
        if (!ROOM_FATAL_ERRORS.has(code)) return;
        stop();
        reject(new Error(`error ${code}: ${message}`));
      };
      meeting.on("meeting-joined", onJoined);
      meeting.on("meeting-left", onLeft);
      meeting.on("error", onError);
    });
  }

  private async subscribeTeleop(): Promise<void> {
    const [ctl, ...optional] = await Promise.allSettled(
      TELEOP_TOPICS.map((topic) =>
        this.subscribeTopic(topic, (message, from) => {
          // Our own publishes echo back.
          if (from !== this.selfId) this.post({ t: "pubsub", topic, from, message });
        }),
      ),
    );
    if (ctl.status === "rejected") throw ctl.reason;
    optional.forEach((result, i) => {
      if (result.status === "rejected") {
        console.warn(`[RoomTransport] cannot subscribe to ${TELEOP_TOPICS[i + 1]}: ${errorText(result.reason)}`);
      }
    });
  }

  /** Live messages only: a stale `claim` or `grant` replayed from history would be worse than none. */
  private subscribeTopic(topic: string, cb: Subscriber): Promise<void> {
    return this.meeting.pubSub.subscribe(
      topic,
      { onMessageReceived: ({ message, senderId }) => cb(message, senderId) },
      { oldMessageLimit: 0 },
    );
  }

  /** Never throws: a send before js-sdk opens its lazy unreliable channel is counted and dropped. */
  private async sendData(bytes: Uint8Array, reliable: boolean): Promise<void> {
    try {
      const sent = await this.meeting.send(bytes, { reliability: reliable ? "RELIABLE" : "UNRELIABLE" });
      if (!sent) this.dropped += 1;
    } catch {
      this.dropped += 1;
    }
  }

  private async publishTo(topic: string, message: string, persist: boolean, sendOnly?: string[]): Promise<void> {
    try {
      await this.meeting.pubSub.publish(topic, message, sendOnly ? { sendOnly, persist } : { persist });
    } catch {
      this.dropped += 1;
    }
  }
}
