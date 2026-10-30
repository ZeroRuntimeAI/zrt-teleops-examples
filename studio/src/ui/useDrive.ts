"use client";
/**
 * Keyboard and touch drive. Keys are looked up by `KeyboardEvent.code` in `KEYMAP`; the jog is
 * derived from the set of held keys and sent only when it changes, so auto-repeat does nothing.
 * Space stops. Losing focus or hiding the tab releases everything (the worker keeps running), and
 * nothing resumes on return until a fresh press.
 */
import { useCallback, useEffect, useRef } from "react";
import { KEYMAP, type JogInput } from "../sim/jog";

const ZERO: JogInput = { x: 0, y: 0, z: 0, roll: 0, grip: 0 };
const AXES = Object.keys(ZERO) as (keyof JogInput)[];
const TEXT_INPUTS = new Set(["text", "search", "email", "url", "tel", "password", "number"]);

const sign = (v: number): -1 | 0 | 1 => (v > 0 ? 1 : v < 0 ? -1 : 0);

/** The jog for a set of held key codes: opposite keys cancel, unknown codes are ignored. */
export function jogFromHeld(held: ReadonlySet<string>): JogInput {
  const sum = (axis: keyof JogInput) => [...held].reduce((acc, code) => acc + (KEYMAP[code]?.[axis] ?? 0), 0);
  return Object.fromEntries(AXES.map((axis) => [axis, sign(sum(axis))])) as JogInput;
}

const sameJog = (a: JogInput, b: JogInput) => AXES.every((axis) => a[axis] === b[axis]);

/** Typing in a field is not driving. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true;
  return target instanceof HTMLInputElement && TEXT_INPUTS.has(target.type);
}

/**
 * Space stops whenever `canStop` (a robot exists, whatever the phase); the drive keys work while
 * `enabled`. Returns press/release for the on-screen hold buttons.
 */
export function useDrive(enabled: boolean, canStop: boolean, jog: (j: JogInput) => void, stop: () => void) {
  const held = useRef<ReadonlySet<string>>(new Set());
  const sent = useRef<JogInput>(ZERO);

  const update = useCallback(
    (next: ReadonlySet<string>) => {
      held.current = next;
      const j = jogFromHeld(next);
      if (sameJog(j, sent.current)) return;
      sent.current = j;
      jog(j);
    },
    [jog],
  );
  const press = useCallback((code: string) => update(new Set([...held.current, code])), [update]);
  const release = useCallback((code: string) => update(new Set([...held.current].filter((c) => c !== code))), [update]);

  useEffect(() => {
    if (!canStop) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code !== "Space" || isTyping(e.target)) return;
      e.preventDefault(); // no page scroll, and no click on a focused button
      if (!e.repeat) stop();
    };
    const onKeyUp = (e: KeyboardEvent) => e.code === "Space" && !isTyping(e.target) && e.preventDefault();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [canStop, stop]);

  useEffect(() => {
    if (!enabled) return;
    /** Always sends a zero jog, even if nothing was held: it releases the worker's deadman. */
    const releaseAll = () => {
      held.current = new Set();
      sent.current = ZERO;
      jog(ZERO);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTyping(e.target) || !(e.code in KEYMAP) || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      press(e.code);
    };
    // A release is always honoured, wherever focus went in between.
    const onKeyUp = (e: KeyboardEvent) => e.code in KEYMAP && release(e.code);
    const onVisibility = () => document.visibilityState === "hidden" && releaseAll();
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", releaseAll);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", releaseAll);
      document.removeEventListener("visibilitychange", onVisibility);
      releaseAll(); // Disabled mid-drive (the session ended): nothing stays held.
    };
  }, [enabled, jog, press, release]);

  return { press, release };
}
