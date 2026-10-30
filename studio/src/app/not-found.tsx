import Link from "next/link";
import { Eyebrow, Icon, btn } from "../ui/ui";

export default function NotFound() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-3xl flex-col justify-center px-4 md:px-10">
      <Eyebrow>404</Eyebrow>
      <h1 className="mt-4 text-5xl font-medium tracking-tight">Nothing here.</h1>
      <p className="mt-3 text-foreground/80">This page doesn&apos;t exist. The robot is on the tabletop.</p>
      <div className="mt-8 flex flex-wrap gap-3">
        <Link href="/tabletop" className={btn.primary}>
          Open the tabletop <Icon name="right" />
        </Link>
        <Link href="/" className={btn.line}>
          Studio home
        </Link>
      </div>
    </main>
  );
}
