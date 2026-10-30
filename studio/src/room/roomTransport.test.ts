import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToWorker } from "../robot/protocol";
import { RoomTransport, type RoomMeeting } from "./roomTransport";

const SELF = "studio";
const CTL = "teleop-v2-ctl";
const REC = "teleop-v2-rec";
const STATS = "teleop-v2-stats";

type Handler = (...args: unknown[]) => void;
type PubSubListeners = { onMessageReceived: (m: { senderId: string; message: string; topic: string }) => void };

/** A tiny emitter standing in for js-sdk's `on` / `off` / event dispatch. */
function emitter() {
  const handlers = new Map<string, Handler[]>();
  return {
    on: vi.fn((event: string, h: Handler) => void handlers.set(event, [...(handlers.get(event) ?? []), h])),
    off: vi.fn((event: string, h: Handler) =>
      void handlers.set(event, (handlers.get(event) ?? []).filter((x) => x !== h)),
    ),
    emit: (event: string, ...args: unknown[]) => (handlers.get(event) ?? []).forEach((h) => h(...args)),
    count: (event: string) => (handlers.get(event) ?? []).length,
  };
}

/** A fake js-sdk `meeting`: just the surface RoomTransport touches, so no WebRTC is involved. */
function fakeMeeting() {
  const meetingEvents = emitter();
  const localEvents = emitter();
  const listeners = new Map<string, PubSubListeners>();
  const streams = new Map<string, { id: string; kind: string }>();
  const raw = {
    messages: [] as unknown[],
    participants: new Map<string, unknown>(),
    localParticipant: { id: SELF, streams, on: localEvents.on, off: localEvents.off },
    on: meetingEvents.on,
    off: meetingEvents.off,
    // js-sdk 1.2.1 resolves join() before the room is joined; `meeting-joined` is the real signal.
    join: vi.fn(async () => meetingEvents.emit("meeting-joined")),
    leave: vi.fn(async () => {}),
    send: vi.fn<(payload: unknown, options?: unknown) => Promise<boolean>>(async () => true),
    muteMic: vi.fn(async () => {}),
    unmuteMic: vi.fn(async () => {}),
    pubSub: {
      publish: vi.fn<(topic: string, message: string, options?: unknown) => Promise<void>>(async () => {}),
      subscribe: vi.fn<(topic: string, l: PubSubListeners, options?: unknown) => Promise<void>>(
        async (topic, l) => void listeners.set(topic, l),
      ),
    },
  };
  return {
    raw,
    meeting: raw as unknown as RoomMeeting,
    emit: meetingEvents.emit,
    emitLocal: localEvents.emit,
    meetingEvents,
    localEvents,
    streams,
    /** A pubsub message arriving from `senderId` on `topic`. */
    deliver: (topic: string, senderId: string, message: string) =>
      listeners.get(topic)?.onMessageReceived({ senderId, message, topic }),
  };
}

/** Joined transport over a fake meeting, with a fake worker attached. */
async function rig() {
  const fake = fakeMeeting();
  const onDisconnected = vi.fn();
  const transport = await RoomTransport.connect(fake.meeting, onDisconnected);
  const posts: ToWorker[] = [];
  transport.attach({ postMessage: (m: ToWorker) => void posts.push(m) } as unknown as Worker);
  return { ...fake, transport, onDisconnected, posts };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("data lanes", () => {
  it("sends a reliable data message on the RELIABLE lane", async () => {
    const { transport, raw } = await rig();
    const bytes = new Uint8Array([1, 2, 3]);
    transport.send({ kind: "data", reliable: true, bytes });
    expect(raw.send).toHaveBeenCalledExactlyOnceWith(bytes, { reliability: "RELIABLE" });
  });

  it("sends an unreliable data message on the UNRELIABLE lane", async () => {
    const { transport, raw } = await rig();
    transport.send({ kind: "data", reliable: false, bytes: new Uint8Array([9]) });
    expect(raw.send).toHaveBeenCalledExactlyOnceWith(new Uint8Array([9]), { reliability: "UNRELIABLE" });
  });

  it("drops, counts, and does not throw when send throws before the channel is open", async () => {
    const { transport, raw } = await rig();
    raw.send.mockImplementation(() => {
      throw new Error("media not ready");
    });
    expect(() => transport.send({ kind: "data", reliable: false, bytes: new Uint8Array([1]) })).not.toThrow();
    expect(transport.droppedLocal).toBe(1);
  });

  it("counts a rejected send and a send that reports false", async () => {
    const { transport, raw } = await rig();
    raw.send.mockRejectedValueOnce(new Error("data-producer failed")).mockResolvedValueOnce(false);
    transport.send({ kind: "data", reliable: true, bytes: new Uint8Array([1]) });
    transport.send({ kind: "data", reliable: true, bytes: new Uint8Array([2]) });
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.droppedLocal).toBe(2);
  });

  it("does not count a send that succeeds", async () => {
    const { transport } = await rig();
    transport.send({ kind: "data", reliable: true, bytes: new Uint8Array([1]) });
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.droppedLocal).toBe(0);
  });

  it("forwards a Uint8Array payload to the worker", async () => {
    const { emit, posts } = await rig();
    const bytes = new Uint8Array([7, 8]);
    emit("data", { payload: bytes, from: "py", timestamp: 1, reliability: "reliable" });
    expect(posts).toEqual([{ t: "data", from: "py", bytes }]);
  });

  it("ignores a string data payload", async () => {
    const { emit, posts } = await rig();
    emit("data", { payload: "hello", from: "py", timestamp: 1, reliability: "reliable" });
    expect(posts).toEqual([]);
  });
});

describe("pubsub", () => {
  it("publishes a targeted ctl message with sendOnly and no persistence", async () => {
    const { transport, raw } = await rig();
    transport.send({ kind: "pubsub", topic: CTL, message: '{"op":"grant"}', sendOnly: ["py"], persist: false });
    expect(raw.pubSub.publish).toHaveBeenCalledExactlyOnceWith(CTL, '{"op":"grant"}', {
      sendOnly: ["py"],
      persist: false,
    });
  });

  it("omits sendOnly for a broadcast and keeps persist for state-like rec events", async () => {
    const { transport, raw } = await rig();
    transport.send({ kind: "pubsub", topic: REC, message: '{"op":"ev"}', persist: true });
    const options = raw.pubSub.publish.mock.calls[0][2];
    expect(options).toEqual({ persist: true });
    expect(options).not.toHaveProperty("sendOnly");
  });

  it("counts a rejected publish instead of leaving it unhandled", async () => {
    const { transport, raw } = await rig();
    raw.pubSub.publish.mockRejectedValueOnce(new Error("reconnecting"));
    transport.send({ kind: "pubsub", topic: CTL, message: "{}", persist: false });
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.droppedLocal).toBe(1);
  });

  it("subscribes to ctl, rec and stats without history", async () => {
    const { raw } = await rig();
    expect(raw.pubSub.subscribe.mock.calls.map(([topic, , options]) => [topic, options])).toEqual([
      [CTL, { oldMessageLimit: 0 }],
      [REC, { oldMessageLimit: 0 }],
      [STATS, { oldMessageLimit: 0 }],
    ]);
  });

  it.each([CTL, REC, STATS])("forwards a peer's %s message to the worker with from = senderId", async (topic) => {
    const { deliver, posts } = await rig();
    deliver(topic, "py", '{"op":"claim"}');
    expect(posts).toEqual([{ t: "pubsub", topic, from: "py", message: '{"op":"claim"}' }]);
  });

  it("does not forward its own echo", async () => {
    const { deliver, posts } = await rig();
    deliver(CTL, SELF, '{"op":"grant"}');
    expect(posts).toEqual([]);
  });

  it("app topics: publish is a plain non-persisted broadcast, subscribe delivers message and sender", async () => {
    const { transport, raw, deliver } = await rig();
    const cb = vi.fn();
    transport.subscribe("ROBOT_EVENTS", cb);
    transport.publish("ROBOT_CTRL", '{"cmd":"stop"}');
    expect(raw.pubSub.publish).toHaveBeenCalledExactlyOnceWith("ROBOT_CTRL", '{"cmd":"stop"}', { persist: false });
    deliver("ROBOT_EVENTS", "agent", "heard");
    expect(cb).toHaveBeenCalledExactlyOnceWith("heard", "agent");
  });
});

describe("participants and connection", () => {
  it("tells the worker when a participant leaves", async () => {
    const { emit, posts } = await rig();
    emit("participant-left", { id: "py" }, {});
    expect(posts).toEqual([{ t: "left", id: "py" }]);
  });

  it("meeting-left tells the worker the connection is gone and calls onDisconnected", async () => {
    const { emit, posts, onDisconnected } = await rig();
    emit("meeting-left", { message: "kicked" });
    expect(posts).toEqual([{ t: "connection", connected: false, why: "kicked" }]);
    expect(onDisconnected).toHaveBeenCalledExactlyOnceWith("kicked");
  });

  it.each([3044, 3047, 4002, 4005, 4009])(
    "the room-fatal error %i tells the worker, calls onDisconnected, and a later event does not repeat it",
    async (code) => {
      const { emit, posts, onDisconnected } = await rig();
      emit("error", { code, message: "room is gone" });
      emit("meeting-left", {});
      expect(posts).toEqual([{ t: "connection", connected: false, why: `error ${code}: room is gone` }]);
      expect(onDisconnected).toHaveBeenCalledExactlyOnceWith(`error ${code}: room is gone`);
    },
  );

  it("a failed send (3070) does not take the room down, and meeting-left still does", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { emit, posts, onDisconnected } = await rig();
    emit("error", { code: 3070, message: "Unable to send the message." });
    expect(posts).toEqual([]);
    expect(onDisconnected).not.toHaveBeenCalled();
    emit("meeting-left", { message: "kicked" });
    expect(posts).toEqual([{ t: "connection", connected: false, why: "kicked" }]);
    expect(onDisconnected).toHaveBeenCalledExactlyOnceWith("kicked");
    warn.mockRestore();
  });

  it("other action errors (mic, webcam, track) are ignored too", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { emit, posts, onDisconnected } = await rig();
    for (const code of [3059, 3031, 3049, 4008, 4010]) emit("error", { code, message: "action failed" });
    expect(posts).toEqual([]);
    expect(onDisconnected).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("logs a non-fatal error at most once per code every 5 s", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { emit } = await rig();
    for (let i = 0; i < 20; i++) emit("error", { code: 3070, message: "send failed" });
    expect(warn).toHaveBeenCalledTimes(1);
    emit("error", { code: 3059, message: "no mic" });
    expect(warn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4_999);
    emit("error", { code: 3070, message: "send failed" });
    expect(warn).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    emit("error", { code: 3070, message: "send failed" });
    expect(warn).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });
});

describe("front camera producer", () => {
  it("announces the webcam stream once it is enabled", async () => {
    const { emitLocal, posts } = await rig();
    emitLocal("stream-enabled", { id: "mic-1", kind: "audio" });
    expect(posts).toEqual([]);
    emitLocal("stream-enabled", { id: "prod-9", kind: "video" });
    expect(posts).toEqual([{ t: "producers", map: { front: "prod-9" } }]);
  });

  it("replays the producer to a worker attached after the stream came up", async () => {
    const fake = fakeMeeting();
    const transport = await RoomTransport.connect(fake.meeting, vi.fn());
    fake.emitLocal("stream-enabled", { id: "prod-9", kind: "video" });
    const postMessage = vi.fn();
    transport.attach({ postMessage } as unknown as Worker);
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({ t: "producers", map: { front: "prod-9" } });
  });

  it("picks up a webcam stream that already exists when join resolves", async () => {
    const fake = fakeMeeting();
    fake.raw.join.mockImplementation(async () => {
      fake.streams.set("prod-3", { id: "prod-3", kind: "video" });
      fake.emit("meeting-joined");
    });
    const transport = await RoomTransport.connect(fake.meeting, vi.fn());
    const postMessage = vi.fn();
    transport.attach({ postMessage } as unknown as Worker);
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({ t: "producers", map: { front: "prod-3" } });
  });

  it("replays a drop that happened before the worker was attached", async () => {
    const fake = fakeMeeting();
    const transport = await RoomTransport.connect(fake.meeting, vi.fn());
    fake.emit("meeting-left", {});
    const postMessage = vi.fn();
    transport.attach({ postMessage } as unknown as Worker);
    expect(postMessage).toHaveBeenCalledExactlyOnceWith({ t: "connection", connected: false, why: "meeting-left" });
  });
});

describe("join and leave", () => {
  it("joins with the studio robot options and the canvas stream as the webcam", async () => {
    const fake = fakeMeeting();
    const stream = { id: "canvas-stream" } as unknown as MediaStream;
    const captureStream = vi.fn(() => stream);
    const sdk = { config: vi.fn(), initMeeting: vi.fn(() => fake.raw) };
    const transport = await RoomTransport.join(
      {
        roomId: "room-1",
        token: "jwt",
        participantId: SELF,
        frontCanvas: { captureStream } as unknown as HTMLCanvasElement,
        onDisconnected: vi.fn(),
      },
      sdk as never,
    );
    expect(captureStream).toHaveBeenCalledExactlyOnceWith(30);
    // What createCameraVideoTrack attaches: without them js-sdk 1.2.1 reads the size from the canvas
    // track's (empty) constraints, simulcasts at NaN scale, and the webcam produce fails (3049).
    expect(stream).toMatchObject({ encoderConfig: "h480p_w640p", multiStream: false });
    expect(sdk.config).toHaveBeenCalledExactlyOnceWith("jwt");
    expect(sdk.initMeeting).toHaveBeenCalledExactlyOnceWith({
      meetingId: "room-1",
      participantId: SELF,
      name: "Studio robot",
      micEnabled: false,
      webcamEnabled: true,
      customCameraVideoTrack: stream,
      multiStream: false,
      mode: "SEND_AND_RECV",
    });
    expect(fake.raw.join).toHaveBeenCalledOnce();
    expect(transport.meeting).toBe(fake.raw);
  });

  it("registers its listeners before joining, so nothing during join is missed", async () => {
    const fake = fakeMeeting();
    const seen: number[] = [];
    fake.raw.join.mockImplementation(async () => {
      seen.push(fake.meetingEvents.count("meeting-left"), fake.meetingEvents.count("meeting-joined"));
      fake.emit("meeting-joined");
    });
    await RoomTransport.connect(fake.meeting, vi.fn());
    // meeting-left: the transport's loss listener plus the join wait's; meeting-joined: the join wait's.
    expect(seen).toEqual([2, 1]);
  });

  it("subscribes only once the room says meeting-joined, not when join() resolves", async () => {
    const fake = fakeMeeting();
    fake.raw.join.mockImplementation(async () => {});
    const connecting = RoomTransport.connect(fake.meeting, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.raw.pubSub.subscribe).not.toHaveBeenCalled();
    fake.emit("meeting-joined");
    await expect(connecting).resolves.toBeInstanceOf(RoomTransport);
    expect(fake.raw.pubSub.subscribe).toHaveBeenCalledTimes(3);
  });

  it("fails the join, and leaves, when the room is lost before meeting-joined", async () => {
    const fake = fakeMeeting();
    fake.raw.join.mockImplementation(async () => {});
    const connecting = RoomTransport.connect(fake.meeting, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    fake.emit("error", { code: 3047, message: "unable to join" });
    await expect(connecting).rejects.toThrow("error 3047: unable to join");
    expect(fake.raw.pubSub.subscribe).not.toHaveBeenCalled();
    expect(fake.raw.leave).toHaveBeenCalledOnce();
  });

  it("fails the join, and leaves, when the ctl subscription fails", async () => {
    const fake = fakeMeeting();
    fake.raw.pubSub.subscribe.mockImplementation(async (topic: string) => {
      if (topic === CTL) throw new Error("pubsub unavailable");
    });
    await expect(RoomTransport.connect(fake.meeting, vi.fn())).rejects.toThrow("pubsub unavailable");
    expect(fake.raw.leave).toHaveBeenCalledOnce();
  });

  it("carries on when only rec or stats cannot be subscribed", async () => {
    const fake = fakeMeeting();
    fake.raw.pubSub.subscribe.mockImplementation(async (topic: string) => {
      if (topic !== CTL) throw new Error("no such topic");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(RoomTransport.connect(fake.meeting, vi.fn())).resolves.toBeInstanceOf(RoomTransport);
    expect(warn).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("clears js-sdk's unbounded message log every 10 s", async () => {
    const { raw } = await rig();
    raw.messages.push({ a: 1 }, { a: 2 });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(raw.messages).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(raw.messages).toHaveLength(0);
  });

  it("clears the log of the array js-sdk holds now, not the one it held at join", async () => {
    const { raw } = await rig();
    raw.messages = [{ a: 1 }];
    await vi.advanceTimersByTimeAsync(10_000);
    expect(raw.messages).toHaveLength(0);
  });

  it("toggles the mic", async () => {
    const { transport, raw } = await rig();
    await transport.enableMic(true);
    expect(raw.unmuteMic).toHaveBeenCalledOnce();
    await transport.enableMic(false);
    expect(raw.muteMic).toHaveBeenCalledOnce();
  });

  it("leave stops the timer and listeners, tells the worker, and does not call onDisconnected", async () => {
    const { transport, raw, emit, meetingEvents, posts, onDisconnected } = await rig();
    await transport.leave();
    expect(raw.leave).toHaveBeenCalledOnce();
    expect(posts).toEqual([{ t: "connection", connected: false, why: "left" }]);
    expect(vi.getTimerCount()).toBe(0);
    expect(meetingEvents.count("meeting-left")).toBe(0);
    emit("meeting-left", {});
    expect(onDisconnected).not.toHaveBeenCalled();
  });

  it("leave still stops the timer when the room refuses to let go", async () => {
    const { transport, raw } = await rig();
    raw.leave.mockRejectedValueOnce(new Error("already left"));
    await expect(transport.leave()).rejects.toThrow("already left");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("the voice agent participant", () => {
  /** A fake js-sdk agent participant, with the audio stream it will publish. */
  function fakeAgent(id = "agent-1") {
    const events = emitter();
    const streams = new Map<string, { kind: string; track: unknown }>();
    return { participant: { id, isAgent: true, streams, on: events.on, off: events.off }, events, streams };
  }
  const collect = (t: { onAgent: (cb: (s: unknown) => void) => () => void }) => {
    const seen: unknown[] = [];
    const stop = t.onAgent((s) => void seen.push(s));
    return { seen, stop };
  };

  it("reports an agent that joins, its state, its transcript lines and its audio track", async () => {
    const { transport, emit } = await rig();
    const { seen } = collect(transport);
    const agent = fakeAgent();
    emit("participant-joined", agent.participant);
    agent.events.emit("agent-state-changed", "speaking");
    agent.events.emit("agent-transcription-received", { segment: { text: "On it.", timestamp: 5, type: "final" }, participant: { id: "agent-1", isAgent: true } });
    agent.events.emit("agent-transcription-received", { segment: { text: "pick up", timestamp: 6 }, participant: { id: SELF } });
    agent.events.emit("agent-transcription-received", { segment: { text: "pick u", timestamp: 6, type: "interim" }, participant: { id: SELF } });
    agent.events.emit("agent-transcription-received", { segment: { text: "who?", timestamp: 7 }, participant: { id: "someone-else" } });
    const track = { kind: "audio" };
    agent.events.emit("stream-enabled", { kind: "audio", track });
    emit("participant-left", { id: "agent-1" });
    expect(seen).toEqual([
      { t: "joined", id: "agent-1" },
      { t: "state", state: "speaking" },
      { t: "said", who: "agent", text: "On it.", at: 5 },
      { t: "said", who: "you", text: "pick up", at: 6 },
      { t: "audio", track },
      { t: "audio", track: null },
      { t: "left" },
    ]);
    expect(agent.events.count("agent-state-changed")).toBe(0);
  });

  it("drops transcript payloads that are malformed", async () => {
    const { transport, emit } = await rig();
    const { seen } = collect(transport);
    const agent = fakeAgent();
    emit("participant-joined", agent.participant);
    const speaker = { id: "agent-1", isAgent: true };
    for (const bad of [undefined, null, {}, { participant: speaker }, { segment: {}, participant: speaker }, { segment: { text: 42 }, participant: speaker }, { segment: { text: { a: 1 } }, participant: speaker }, "text"]) {
      agent.events.emit("agent-transcription-received", bad);
    }
    agent.events.emit("agent-transcription-received", { segment: { text: "fine", timestamp: "soon" }, participant: speaker });
    expect(seen).toEqual([{ t: "joined", id: "agent-1" }, { t: "said", who: "agent", text: "fine", at: undefined }]);
  });

  it("ignores a participant that is not an agent", async () => {
    const { transport, emit } = await rig();
    const { seen } = collect(transport);
    emit("participant-joined", { id: "p2", isAgent: false });
    expect(seen).toEqual([]);
  });

  it("replays an agent that is already known to a listener that comes late", async () => {
    const { transport, emit } = await rig();
    const agent = fakeAgent();
    emit("participant-joined", agent.participant);
    agent.events.emit("agent-state-changed", "listening");
    const { seen } = collect(transport);
    expect(seen).toEqual([{ t: "joined", id: "agent-1" }, { t: "state", state: "listening" }]);
  });

  it("adopts an agent that was in the room before this tab joined, and lets go when this tab leaves", async () => {
    const fake = fakeMeeting();
    const agent = fakeAgent();
    agent.streams.set("a", { kind: "audio", track: { kind: "audio" } });
    fake.raw.participants.set(agent.participant.id, agent.participant);
    const transport = await RoomTransport.connect(fake.meeting, vi.fn());
    const { seen } = collect(transport);
    expect(seen).toEqual([{ t: "joined", id: "agent-1" }, { t: "audio", track: { kind: "audio" } }]);
    await transport.leave();
    expect(seen.at(-1)).toEqual({ t: "left" });
    expect(agent.events.count("stream-enabled")).toBe(0);
  });
});
