/**
 * The sound of the arm's servos, synthesized with Web Audio: no audio files. Each joint is one
 * motor, a low sawtooth hum plus a thin gear whine. Both rise in pitch and loudness with how fast
 * that joint turns, and fall silent when it holds, the way an SO-101's STS3215 servos sound.
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import { JOINTS, type JointName } from "../sim/jointMap";

/** Below this many degrees (gripper: percent) per second a joint is holding, not moving. */
const DEADBAND = 1.5;
/** The speed past the deadband at which a joint is at full loudness. */
const FULL_SPEED = 60;
/** The whole arm's level: servos are background, never louder than the agent's voice. */
const MASTER = 0.14;
/** How quickly the sound follows the arm, in seconds: smooths the 60 Hz pose steps. */
const FOLLOW_S = 0.04;
/** Big motors turn a heavy link and sound lower; the wrist and gripper motors sound higher. */
const PITCH: Record<JointName, number> = {
  shoulder_pan: 0.85,
  shoulder_lift: 0.8,
  elbow_flex: 0.95,
  wrist_flex: 1.15,
  wrist_roll: 1.25,
  gripper: 1.4,
};
const PREF_KEY = "studio.servoSound";

export type ServoVoice = { gain: number; humHz: number; whineHz: number };

/** What one motor sounds like at `speed` (absolute units per second). */
export function servoVoice(joint: JointName, speed: number): ServoVoice {
  const level = Math.min(Math.max((speed - DEADBAND) / FULL_SPEED, 0), 1);
  const k = PITCH[joint];
  return {
    gain: level > 0 ? level ** 0.6 : 0,
    humHz: Math.min(k * (70 + 3.2 * speed), 800),
    whineHz: Math.min(k * (1400 + 9 * speed), 5000),
  };
}

/** Absolute change per second, joint by joint; standing still without a previous frame or a time step. */
export function jointSpeeds(prev: Float64Array | null, next: Float64Array, dtS: number): Float64Array {
  const out = new Float64Array(next.length);
  if (!prev || dtS <= 0) return out;
  for (let i = 0; i < next.length; i++) out[i] = Math.abs(next[i] - prev[i]) / dtS;
  return out;
}

type Motor = { gain: GainNode; hum: OscillatorNode; whine: OscillatorNode };

/** One AudioContext and one motor per joint, built on first use, after a user gesture. */
class ServoSound {
  private readonly ctx = new AudioContext();
  private readonly motors: Motor[];

  constructor() {
    const master = new GainNode(this.ctx, { gain: MASTER });
    master.connect(this.ctx.destination);
    this.motors = JOINTS.map(() => {
      const gain = new GainNode(this.ctx, { gain: 0 });
      gain.connect(master);
      const hum = new OscillatorNode(this.ctx, { type: "sawtooth" });
      hum.connect(new BiquadFilterNode(this.ctx, { type: "lowpass", frequency: 1200 })).connect(gain);
      const whine = new OscillatorNode(this.ctx, { type: "square" });
      const whineLevel = new GainNode(this.ctx, { gain: 0.25 });
      whine.connect(new BiquadFilterNode(this.ctx, { type: "bandpass", Q: 6 })).connect(whineLevel).connect(gain);
      hum.start();
      whine.start();
      return { gain, hum, whine };
    });
  }

  set(speeds: Float64Array): void {
    const t = this.ctx.currentTime;
    JOINTS.forEach((name, i) => {
      const v = servoVoice(name, speeds[i] ?? 0);
      const m = this.motors[i];
      m.gain.gain.setTargetAtTime(v.gain, t, FOLLOW_S);
      m.hum.frequency.setTargetAtTime(v.humHz, t, FOLLOW_S);
      m.whine.frequency.setTargetAtTime(v.whineHz, t, FOLLOW_S);
    });
  }

  resume = () => void this.ctx.resume().catch(() => {});
  suspend = () => void this.ctx.suspend().catch(() => {});
  close = () => void this.ctx.close().catch(() => {});
}

/** The visitor's choice, remembered in this browser. On unless they turned it off. */
export function useServoSoundPref(): { on: boolean; toggle: () => void } {
  const [on, setOn] = useState(() => {
    try {
      return localStorage.getItem(PREF_KEY) !== "off";
    } catch {
      return true;
    }
  });
  const toggle = () =>
    setOn((was) => {
      try {
        localStorage.setItem(PREF_KEY, was ? "off" : "on");
      } catch {
        // No storage (private window): the choice lasts for this page only.
      }
      return !was;
    });
  return { on, toggle };
}

/**
 * Plays the servos from `joints` (the worker's latest, replaced at up to 60 Hz) while `on`.
 * Browsers start audio only after a gesture, so the sound begins with the first click or key.
 * A hidden tab is suspended: rAF stops there, and a motor would otherwise hold its last note.
 */
export function useServoSound(joints: RefObject<Float64Array | null>, on: boolean): void {
  const sound = useRef<ServoSound | null>(null);
  useEffect(() => {
    if (!on || typeof AudioContext === "undefined") return;
    let frame = 0;
    let last: { joints: Float64Array; at: number } | null = null;
    const start = () => {
      sound.current ??= new ServoSound();
      if (document.visibilityState === "visible") sound.current.resume();
    };
    const onVisibility = () => (document.visibilityState === "visible" ? sound.current?.resume() : sound.current?.suspend());
    const tick = () => {
      frame = requestAnimationFrame(tick);
      const now = joints.current;
      if (!sound.current || !now || now === last?.joints) return;
      const at = performance.now();
      sound.current.set(jointSpeeds(last?.joints ?? null, now, last ? (at - last.at) / 1000 : 0));
      last = { joints: now, at };
    };
    window.addEventListener("pointerdown", start);
    window.addEventListener("keydown", start);
    document.addEventListener("visibilitychange", onVisibility);
    // Turned back on by a click: that gesture has already happened, so start now.
    if (navigator.userActivation?.hasBeenActive) start();
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", start);
      window.removeEventListener("keydown", start);
      document.removeEventListener("visibilitychange", onVisibility);
      sound.current?.close();
      sound.current = null;
    };
  }, [joints, on]);
}
