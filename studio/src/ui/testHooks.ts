/**
 * `window.__studio`, for e2e only: installed when the build has `NEXT_PUBLIC_STUDIO_TEST_HOOKS=1`,
 * absent otherwise.
 */
import type { RobotStatus } from "../robot/protocol";
import type { OfflineTransport } from "../room/transport";

export type StudioTestHooks = {
  status(): RobotStatus | null;
  /** Height of the `gripperframe` site in metres (NaN before the first status). */
  gripperZ(): number;
  /** Offline sessions have no server to say Voice exists: a test turns it on (or off) here. */
  setVoiceAvailable(available: boolean): void;
  /** End the session `ms` from now. */
  expireIn(ms: number): void;
  /** Tell the robot the room is gone, as a lost connection would. */
  simulateDisconnect(): void;
  transport(): OfflineTransport | null;
  /** Set by a test: the voice queue's poll interval in ms, instead of five seconds. */
  voicePollMs?: number;
};

declare global {
  interface Window {
    __studio: StudioTestHooks;
  }
}

export const TEST_HOOKS = process.env.NEXT_PUBLIC_STUDIO_TEST_HOOKS === "1";

/** Install the hooks when the build enables them; returns the uninstaller. */
export function installTestHooks(hooks: StudioTestHooks): () => void {
  if (!TEST_HOOKS) return () => {};
  window.__studio = hooks;
  return () => {
    if (window.__studio === hooks) delete (window as Partial<Window>).__studio;
  };
}
