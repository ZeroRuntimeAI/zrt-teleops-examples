/** Small presentational pieces shared by the workspace (lifted from the approved Task 10 mockup). */
import type { ReactNode } from "react";

export const LINKS = {
  docs: "https://docs.zeroruntime.ai/robotics/overview",
  github: "https://github.com/ZeroRuntimeAI/zrt-teleops-examples",
  console: "https://app.zeroruntime.ai/robotics/sessions",
} as const;

export function Eyebrow({
  children,
  className = "",
  as: Tag = "p",
  id,
}: {
  children: ReactNode;
  className?: string;
  as?: "p" | "h2" | "h3";
  id?: string;
}) {
  return (
    <Tag id={id} className={`font-mono text-micro font-normal uppercase tracking-[0.14em] text-muted ${className}`}>
      {children}
    </Tag>
  );
}

const control = "inline-flex items-center justify-center gap-2 whitespace-nowrap transition-colors duration-[var(--duration-fast)]";
export const btn = {
  primary: `${control} h-11 bg-primary px-5 text-sm font-medium text-on-primary hover:brightness-110 active:brightness-95`,
  ghost: `${control} h-10 px-3 text-ui text-foreground/80 hover:bg-hairline-strong hover:text-foreground active:bg-foreground/15`,
  line: `${control} h-11 border border-hairline-strong px-4 text-sm text-foreground/90 hover:border-foreground/30 hover:bg-hairline active:bg-hairline-strong`,
};

/** Square icon buttons in the chrome. */
export const iconButton =
  "grid place-items-center text-foreground/70 transition-colors duration-[var(--duration-fast)] hover:bg-hairline-strong hover:text-foreground active:bg-foreground/15";

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-grid h-[22px] min-w-[22px] place-items-center border border-hairline-strong border-b-foreground/25 bg-surface-raised px-1 font-mono text-micro text-foreground/90">
      {children}
    </kbd>
  );
}

/** The lit stage inside dark chrome: a warm pool of light behind the table, falling off to the app background. */
export const STAGE_BACKDROP =
  "bg-[radial-gradient(90%_75%_at_50%_42%,#3b3934_0%,#26252a_38%,var(--color-background)_78%)]";

/** Translucent chrome over the stage. Depth comes from overlap and blur, never from shadows. */
// Nearly opaque: over the bright table a thinner glass drops small muted text below AA contrast.
export const glass = "border border-hairline-strong bg-surface/95 backdrop-blur-xl";

const ICONS = {
  back: "M7 3 2 8l5 5M2 8h12",
  keyboard: "M1.5 4.5h13v7h-13zM4 7h1m2 0h1m2 0h1M5 9.5h6",
  mic: "M6 1.5h4v7H6zM3.5 7a4.5 4.5 0 0 0 9 0M8 11.5v3",
  stop: "M5.5 1.5h5l4 4v5l-4 4h-5l-4-4v-5z",
  reset: "M2.5 2.5v4h4M3.2 6.5A5.5 5.5 0 1 1 3.6 10.5",
  up: "M3.5 10 8 5.5l4.5 4.5",
  down: "M3.5 6 8 10.5 12.5 6",
  left: "M10 3.5 5.5 8l4.5 4.5",
  right: "M6 3.5 10.5 8 6 12.5",
  rollLeft: "M6.5 1.5 4 4l2.5 2.5M4 4h5a4.5 4.5 0 1 1-4.5 4.5",
  rollRight: "M9.5 1.5 12 4 9.5 6.5M12 4H7a4.5 4.5 0 1 0 4.5 4.5",
  close: "m3.5 3.5 9 9m0-9-9 9",
  alert: "M8 1.5 15 14H1zM8 6v4m0 2v.01",
  external: "M6 3h7v7M13 3 4 12",
  panel: "M1.5 2.5h13v11h-13zM10 2.5v11",
  code: "M5.5 4.5 2 8l3.5 3.5m5-7L14 8l-3.5 3.5",
  check: "m3 8.5 3.5 3.5L13 4.5",
  copy: "M5.5 5.5h8v8h-8zM2.5 10.5v-8h8",
  sound: "M2 6h3l4-3.5v11L5 10H2zM11.5 5.5a3.5 3.5 0 0 1 0 5M13 3.5a6.5 6.5 0 0 1 0 9",
  soundOff: "M2 6h3l4-3.5v11L5 10H2zM11 6l4 4m0-4-4 4",
} as const;

export function Icon({ name, className = "size-4" }: { name: keyof typeof ICONS; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="square" aria-hidden className={className}>
      <path d={ICONS[name]} />
    </svg>
  );
}
