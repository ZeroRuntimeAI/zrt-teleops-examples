import Link from "next/link";
import { readEnv } from "../server/env";
import { simFiles } from "../server/simFiles";
import { SimBadge } from "../ui/StatusPills";
import { Preview } from "../ui/Preview";
import { Eyebrow, Icon, LINKS, btn } from "../ui/ui";

/** Facts about the build, not measurements: safe to show before anything runs. */
const SPEC = [
  ["Robot", "SO-101 · studio-so101"],
  ["Control loop", "100 Hz in this tab"],
  ["Physics", "MuJoCo 3.16 · WebAssembly"],
  ["Safety", "Watchdog · deadman · slew clamp"],
] as const;

/** Per request: whether Voice is offered depends on the deployment's env, not the build's. */
export const dynamic = "force-dynamic";

/** Voice is mentioned only when an agent is configured. An invalid env never breaks the home page: no voice. */
function voiceConfigured(): boolean {
  try {
    return readEnv().voiceAgentId !== null;
  } catch {
    return false;
  }
}

const NAV = [
  ["Docs", LINKS.docs],
  ["GitHub", LINKS.github],
  ["Console", LINKS.console],
] as const;

export default function HomePage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="flex min-h-14 flex-wrap items-center justify-between gap-x-4 border-b border-hairline px-4 md:px-10">
        <Link href="/" className="flex items-baseline gap-2 whitespace-nowrap text-sm">
          <span className="font-semibold tracking-tight">Zero Runtime</span>
          <span className="text-muted">Studio</span>
        </Link>
        <nav aria-label="Zero Runtime" className="-mr-2 flex items-center sm:-mr-3">
          {NAV.map(([label, url]) => (
            <a key={label} href={url} target="_blank" rel="noreferrer" className={`${btn.ghost} gap-1.5 px-2 sm:px-3`}>
              {label}
              <Icon name="external" className="hidden size-3 text-muted sm:block" />
            </a>
          ))}
        </nav>
      </header>

      <main className="flex-1">
        <section
          aria-labelledby="task-title"
          className="grid gap-x-16 gap-y-8 px-4 pb-10 pt-12 md:px-10 md:pt-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] lg:items-end lg:pb-14"
        >
          <div>
            <Eyebrow>Physical AI · Featured task</Eyebrow>
            <h1 id="task-title" className="mt-5 text-[clamp(2.75rem,1.2rem+6.4vw,7.5rem)] font-medium leading-[0.92] tracking-[-0.045em]">
              <span className="block">Put the cubes</span>
              <span className="block text-muted">in the box.</span>
            </h1>
          </div>
          <div className="lg:pb-2">
            <p className="text-[17px] leading-relaxed text-foreground/85">
              A physics-simulated SO-101 arm runs in this tab as a real <code className="font-mono text-[15px] text-foreground">zeroruntime-teleops</code>{" "}
              robot. {voiceConfigured() ? "Drive it with your keyboard, or ask a voice agent to do it." : "Drive it with your keyboard. Voice control is coming soon."}
            </p>
            <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-3">
              <Link href="/tabletop" className={btn.primary}>
                Open the tabletop
                <Icon name="right" className="size-4" />
              </Link>
              <span className="font-mono text-micro text-muted">5-minute session · no sign-in</span>
            </div>
          </div>
        </section>

        <section
          aria-label="Live preview of the tabletop"
          className="relative mx-4 h-[clamp(260px,72vw,420px)] overflow-hidden border border-hairline-strong md:mx-10 md:h-[clamp(380px,42vw,640px)]"
        >
          <Preview files={simFiles} />
          <div className="absolute left-3 top-3">
            <SimBadge />
          </div>
        </section>

        <dl className="mx-4 grid grid-cols-2 gap-px border-x border-b border-hairline bg-hairline md:mx-10 lg:grid-cols-4">
          {SPEC.map(([term, value]) => (
            <div key={term} className="bg-background px-4 py-4 md:px-5">
              <dt className="font-mono text-micro uppercase tracking-[0.14em] text-muted">{term}</dt>
              <dd className="mt-1.5 text-ui text-foreground/90">{value}</dd>
            </div>
          ))}
        </dl>
      </main>

      <footer className="mt-20 flex flex-col gap-2 border-t border-hairline px-4 py-6 text-ui text-muted md:flex-row md:items-center md:justify-between md:px-10">
        <p>Zero Runtime Physical AI. Studio is a simulation; no physical robot is connected.</p>
        <p className="font-mono text-micro">SO-101: MuJoCo Menagerie · tabletop: LeRobot EnvHub · Apache-2.0</p>
      </footer>
    </div>
  );
}
