import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import loadMujoco, { type MainModule } from "@mujoco/mujoco";
import { Scene } from "./scene";

const SIM_DIR = join(import.meta.dirname, "../../public/sim");

/** Every model file under public/sim (NOTICE excluded), keyed by its posix path. */
function readSimFiles(dir = SIM_DIR): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      Object.assign(files, readSimFiles(path));
    } else if (entry.name !== "NOTICE") {
      files[relative(SIM_DIR, path).split(sep).join("/")] = new Uint8Array(readFileSync(path));
    }
  }
  return files;
}

/** Test-only: boot the MuJoCo WASM and compile the real tabletop scene from `public/sim`. */
export async function loadTestScene(): Promise<{ mj: MainModule; scene: Scene }> {
  const mj = await loadMujoco();
  return { mj, scene: Scene.load(mj, readSimFiles()) };
}
