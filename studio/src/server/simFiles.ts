import { readdirSync, statSync } from "node:fs";
import { join, sep } from "node:path";

const SIM_DIR = join(process.cwd(), "public/sim");

/** Every model file under public/sim (NOTICE excluded), keyed as `scene.xml` sees them. Server only. */
export const simFiles: readonly string[] = readdirSync(SIM_DIR, { recursive: true, encoding: "utf8" })
  .filter((p) => p !== "NOTICE" && statSync(join(SIM_DIR, p)).isFile())
  .map((p) => p.split(sep).join("/"));
