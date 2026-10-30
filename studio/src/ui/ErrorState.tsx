"use client";
/** The centred plates over the stage, and the error one: what failed, in words, and a Retry. */
import type { ReactNode } from "react";
import type { RobotError } from "./useRobot";
import { Icon, LINKS, btn, glass } from "./ui";

export function Plate({ children, alert = false }: { children: ReactNode; alert?: boolean }) {
  return (
    <div role={alert ? "alert" : "status"} className={`pointer-events-auto w-full max-w-[25rem] p-6 sm:p-7 ${glass}`}>
      {children}
    </div>
  );
}

const NEEDS = "Studio needs WebGL2 and WebAssembly.";

const COPY: Record<RobotError["kind"], { title: string; body: string }> = {
  webgl: {
    title: "Couldn't load the robot",
    body: `This browser didn't give Studio a WebGL2 context, so the 3D stage can't start. ${NEEDS}`,
  },
  wasm: {
    title: "Couldn't load the robot",
    body: `This browser can't run WebAssembly, so the physics simulation can't start. ${NEEDS}`,
  },
  load: {
    title: "Couldn't load the robot",
    body: "The robot's model or physics engine didn't load, so the simulation stopped. Check your connection and retry.",
  },
  room: {
    title: "Couldn't join the room",
    body: "The robot runs in a live room so other operators can drive it, and Studio couldn't open one.",
  },
};

export function ErrorState({ error, retry }: { error: RobotError; retry(): void }) {
  const { title, body } = COPY[error.kind];
  const browser = error.kind === "webgl" || error.kind === "wasm";
  return (
    <Plate alert>
      <Icon name="alert" className="size-5 text-foreground/80" />
      <h2 className="mt-4 text-2xl font-medium tracking-tight">{title}</h2>
      <p className="mt-2 text-sm leading-relaxed text-foreground/80">{body}</p>
      <p className="mt-4 break-words border border-hairline bg-background px-3 py-2 font-mono text-micro text-muted">{error.message}</p>
      <div className="mt-6 flex flex-wrap gap-3">
        <button type="button" onClick={retry} className={btn.primary}>
          <Icon name="reset" /> Retry
        </button>
        {browser && (
          <a href={LINKS.docs} target="_blank" rel="noreferrer" className={btn.line}>
            Requirements <Icon name="external" className="size-3 text-muted" />
          </a>
        )}
      </div>
    </Plate>
  );
}
