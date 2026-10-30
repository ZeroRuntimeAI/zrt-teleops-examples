"use client";
/**
 * Voice mode: ask the server to put the Zero Runtime voice agent in this room (`POST /api/voice`,
 * polled while the line is full), open the mic, and hand control to the agent. The agent's side
 * arrives as `ROBOT_EVENTS` pubsub messages (believed only from the agent participant) and as that
 * participant's js-sdk events; both feed one reducer (`voiceEvents.ts`). The request and polling
 * live in `voiceSession.ts`.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { TEST_HOOKS } from "./testHooks";
import type { Robot } from "./useRobot";
import { acceptRobotEvent, initialVoice, reduceVoice, type VoiceState } from "./voiceEvents";
import { VoiceLifecycle, pause, postVoice, type Language } from "./voiceSession";

export type { Language } from "./voiceSession";
/** The pubsub topic the agent reports on. */
export const ROBOT_EVENTS = "ROBOT_EVENTS";

export type Voice = {
  state: VoiceState;
  language: Language;
  setLanguage(language: Language): void;
  /** Why Voice isn't on, until the next try or the switch back to Keyboard. */
  error?: string;
  /** The agent's audio track while it is in the room, for the level meter. */
  track: MediaStreamTrack | null;
  /** The server has a voice agent. When false the Voice toggle is disabled and nothing is requested. */
  available: boolean;
  /** Voice mode is on, or waiting in line for it. */
  active: boolean;
  on(): void;
  off(): void;
};

/** E2e shortens the five-second poll; nothing else does. */
const testPollMs = () => (TEST_HOOKS ? window.__studio?.voicePollMs : undefined);

export function useVoice(robot: Pick<Robot, "transport" | "roomId" | "phase" | "handBack" | "enableMic" | "note" | "end" | "voiceAvailable">): Voice {
  const { transport, roomId, phase, handBack, enableMic, note, end } = robot;
  const [state, dispatch] = useReducer(reduceVoice, initialVoice);
  const [language, setLanguage] = useState<Language>("en");
  const [error, setError] = useState<string>();
  /** The server answered 503 voice_unavailable although the session said otherwise (config changed under us). */
  const [refused, setRefused] = useState(false);
  const available = robot.voiceAvailable && !refused;
  const [track, setTrack] = useState<MediaStreamTrack | null>(null);
  const [lifecycle] = useState(() => new VoiceLifecycle());
  /** The agent participant's id, once it is in the room: the only sender of `ROBOT_EVENTS` we believe. */
  const agentId = useRef<string | null>(null);

  useEffect(() => {
    if (!transport) return;
    let live = true;
    transport.subscribe(ROBOT_EVENTS, (message, from) => {
      const event = live ? acceptRobotEvent(message, from, agentId.current) : null;
      if (event) dispatch(event.t === "say" ? { ...event, at: Date.now() } : event);
    });
    const unsubscribe = transport.onAgent((signal) => {
      if (!live) return;
      switch (signal.t) {
        case "joined":
          agentId.current = signal.id;
          return note({ op: "app", what: "voice", step: "joined" });
        case "left":
          agentId.current = null;
          return dispatch({ t: "agent", state: "idle" });
        case "state":
          return dispatch({ t: "agent", state: signal.state });
        case "said":
          return dispatch({ t: "say", who: signal.who, text: signal.text, at: signal.at ?? Date.now() });
        case "audio":
          return setTrack(signal.track);
      }
    });
    return () => {
      live = false;
      unsubscribe();
    };
  }, [transport, note]);

  const off = useCallback(() => {
    lifecycle.stop();
    setError(undefined);
    dispatch({ t: "off" });
    void enableMic(false).catch(() => {}); // Already muted, or the room is gone: nothing to undo.
  }, [lifecycle, enableMic]);

  const on = useCallback(() => {
    if (!available || !roomId || state.agent !== "off") return;
    void lifecycle.start({
      request: (signal) => postVoice(roomId, language, signal),
      pause,
      enableMic,
      handBack,
      dispatch,
      note,
      setError,
      end,
      unavailable: () => setRefused(true),
      pollMs: testPollMs(),
    });
  }, [lifecycle, available, roomId, language, state.agent, enableMic, handBack, note, end]);

  // The session is over or the room is lost: no agent to wait for.
  useEffect(() => {
    if (phase === "ready") return;
    lifecycle.stop();
    dispatch({ t: "off" });
  }, [lifecycle, phase]);
  useEffect(() => () => lifecycle.stop(), [lifecycle]);

  return { state, language, setLanguage, error, track, available, active: state.agent !== "off", on, off };
}
