import type { OutboundMsg } from "../robot/protocol";

/** What the voice agent's participant reports: it came or went, its state, a transcript line, its audio. */
export type AgentSignal =
  /** `id` is the agent participant's id: the only sender whose `ROBOT_EVENTS` are believed. */
  | { t: "joined"; id: string }
  | { t: "left" }
  | { t: "state"; state: string }
  | { t: "said"; who: "you" | "agent"; text: string; at?: number }
  | { t: "audio"; track: MediaStreamTrack | null };

/** What the app needs from the room: the real one is `RoomTransport`, e2e and credential-less dev use `OfflineTransport`. */
export interface Transport {
  /** Wire the robot worker in: it gets the room's inbound traffic. */
  attach(worker: Worker): void;
  /** One outbound teleop message from the worker, in order. */
  send(msg: OutboundMsg): void;
  /** An app-level message (such as `ROBOT_CTRL`), broadcast and not persisted. */
  publish(topic: string, message: string): void;
  /** App-level messages on `topic`, with the sender's id. Not filtered: skip your own by `from`. */
  subscribe(topic: string, cb: (message: string, from: string) => void): void;
  enableMic(on: boolean): Promise<void>;
  /** The js-sdk agent participant's events, replaying what is already known. Returns the unsubscribe. */
  onAgent(cb: (signal: AgentSignal) => void): () => void;
  leave(): Promise<void>;
}

type Subscriber = (message: string, from: string) => void;

/** No room at all: records what the app publishes, and lets a test inject what a peer would say. */
export class OfflineTransport implements Transport {
  readonly published: { topic: string; message: string }[] = [];
  /** How many teleop messages the worker has handed over; they go nowhere. */
  sent = 0;
  private readonly subscribers = new Map<string, Subscriber[]>();

  attach: Transport["attach"] = () => {};

  send: Transport["send"] = () => {
    this.sent += 1;
  };

  publish(topic: string, message: string): void {
    this.published.push({ topic, message });
  }

  subscribe(topic: string, cb: Subscriber): void {
    this.subscribers.set(topic, [...(this.subscribers.get(topic) ?? []), cb]);
  }

  /** Test injection: deliver `message` on `topic` as if `from` had published it. */
  emit(topic: string, message: string, from: string): void {
    for (const cb of this.subscribers.get(topic) ?? []) cb(message, from);
  }

  enableMic: Transport["enableMic"] = async () => {};

  private readonly agentListeners = new Set<(signal: AgentSignal) => void>();

  onAgent(cb: (signal: AgentSignal) => void): () => void {
    this.agentListeners.add(cb);
    return () => void this.agentListeners.delete(cb);
  }

  /** Test injection: deliver what the agent participant would report. */
  emitAgent(signal: AgentSignal): void {
    this.agentListeners.forEach((cb) => cb(signal));
  }

  /** Whether `leave()` was called: a test can check the app gave up the room. */
  left = false;

  leave: Transport["leave"] = async () => {
    this.left = true;
  };
}
