/**
 * The robot's Web Worker entry: boots MuJoCo, the teleop core and a RobotHost on `init`, then
 * hands every other message to the host. Spawn it with
 * `new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })`.
 */
import loadMujoco from "@mujoco/mujoco";
import initTeleops, { FollowerHost } from "@zeroruntime/teleops-wasm";
import { Scene } from "../sim/scene";
import { systemClock } from "./clock";
import { followerConfig, RobotHost } from "./host";
import type { FromWorker, ToWorker, WasmModule } from "./protocol";

const post = (m: FromWorker) => self.postMessage(m, m.t === "poses" ? { transfer: [m.poses.buffer, m.joints.buffer] } : {});
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Both packages fetch their `.wasm` with the global `fetch` while booting: count the bytes as they
 * stream in, so the loading screen shows real progress.
 */
const baseFetch = self.fetch.bind(self);
self.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const res = await baseFetch(input, init);
  const url = input instanceof Request ? input.url : String(input);
  if (!res.ok || !res.body || !/\.wasm(\?|$)/.test(url)) return res;
  const which: WasmModule = /mujoco/i.test(url) ? "physics" : "core";
  const total = Number(res.headers.get("content-length")) || 0;
  let loaded = 0;
  const counted = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, out) {
      loaded += chunk.byteLength;
      post({ t: "progress", module: which, loaded, total });
      out.enqueue(chunk);
    },
    // Compressed responses carry no usable length: the end of the stream is the total.
    flush() {
      post({ t: "progress", module: which, loaded, total: loaded });
    },
  });
  return new Response(res.body.pipeThrough(counted), { status: res.status, statusText: res.statusText, headers: res.headers });
};

let host: RobotHost | null = null;
/** What arrives while booting, replayed once the host is up: a lost `connection` would hide a drop. */
const early: ToWorker[] = [];

async function boot({ files, selfId, seed }: Extract<ToWorker, { t: "init" }>): Promise<void> {
  // Both packages fetch their .wasm from `new URL("<name>.wasm", import.meta.url)` beside their JS,
  // which the bundler emits as an asset.
  const [mj] = await Promise.all([loadMujoco(), initTeleops()]);
  const scene = Scene.load(mj, files);
  scene.reset(seed);
  const robot = new RobotHost(scene, new FollowerHost(followerConfig(selfId)), post, systemClock);
  robot.start();
  host = robot;
  for (const m of early.splice(0)) robot.handle(m);
  post({ t: "ready" });
}

self.onmessage = ({ data: m }: MessageEvent<ToWorker>) => {
  if (m.t === "init") {
    boot(m).catch((e) => post({ t: "error", message: errorText(e) }));
  } else if (!host) {
    early.push(m);
  } else {
    try {
      host.handle(m);
    } catch (e) {
      post({ t: "error", message: errorText(e) });
    }
  }
};
