export type Clock = { monoS(): number; wallMs(): number };

export const systemClock: Clock = {
  monoS: () => performance.now() / 1000,
  wallMs: () => Date.now(),
};
