# ZeroRuntime Studio

A Zero Runtime Physical AI playground. You get a simulated SO-101 arm and a tabletop with four cubes and a
box, drive it from the keyboard (or from your own Python script), and see the teleop SDK working underneath.
Voice is optional and off by default: it needs the voice worker in `studio/agent/` deployed and `STUDIO_VOICE_AGENT_ID` set (see [3. Voice worker](#3-voice-worker)).

**The browser tab is a real `zeroruntime-teleops` Follower** (robot id `studio-so101`). MuJoCo runs in a Web
Worker; every command, whether from the keyboard or your own Python script (or, once deployed, the voice agent), crosses the same
wire protocol and the same Rust safety gates (lease, deadman, watchdog, clamp, slew, e-stop) that a physical
SO-101 uses. Code you write against Studio drives a real arm unchanged.

The SIMULATION badge is always visible. When enabled, the voice agent's pick-and-place is a scripted planner that uses exact
simulator positions, and Studio labels it that way.

## Run it

Requires Node 20+. Until `@zeroruntime/teleops-wasm` is on npm, a local `npm ci` needs the sibling
`videosdk-rust-sdk` checkout that `package.json` points at; see [Temporary dependency](#temporary-dependency).

```bash
cd studio
npm ci
```

### 1. Offline (no credentials)

No room, no server calls. The sim, keyboard teleop and the developer drawer all work.

```bash
NEXT_PUBLIC_STUDIO_OFFLINE=1 npm run dev
```

Open <http://localhost:3000/tabletop>.

### 2. With credentials (rooms, Python leader, voice)

```bash
cp .env.example .env.local   # fill in ZERORUNTIME_API_KEY and ZERORUNTIME_SECRET; STUDIO_VOICE_AGENT_ID is optional
npm run dev
```

Each visit creates a VideoSDK room and a short-lived join-only token (`POST /api/session`). The workspace shows
the room id. Drive the arm from another machine with the developer path below.

### 3. Voice worker

`studio/agent/worker.py` is the Zero Runtime voice agent that joins a visitor's room. It reuses the `voice/` example:
its `RobotAgent` tools (except `pick_up` and `place`, which use the planner below), `MotionController`, `VoiceLeader` and skills. Each dispatched room gets its own teleops
Leader, targeting the browser follower `studio-so101`, and its own `MotionController`. English is the default; a
dispatch with metadata `{"language": "hi"}` gets Hindi.

`pick_up` and `place` run a scripted planner (`studio/agent/planner.py`) that reads exact cube and box positions
from the simulator. Every successful `pick_up` or `place` result is labelled `scripted planner · uses exact simulator positions`; errors from the planner, the scene read or the health checks come back as ordinary tool errors. This is for the
simulated arm only: a real arm has no scene oracle.

Voice is optional. With `STUDIO_VOICE_AGENT_ID` unset (the default), the Voice toggle is disabled with "Voice is not
available yet", `/api/session` reports `voiceAvailable: false`, and `POST /api/voice` answers 503
`voice_unavailable` without taking a slot or dispatching. Set `STUDIO_VOICE_AGENT_ID` in the Studio server's
environment to the id the worker registers under (`ZERORUNTIME_AGENT_ID`), and the Studio server dispatches the agent
into each room (`POST /api/voice`).

To run the worker locally, from the repo root on Python 3.12 (the version the image uses):

```bash
pip install -r studio/agent/requirements.txt
ZERORUNTIME_AUTH_TOKEN=... ZERORUNTIME_AGENT_ID=... python studio/agent/worker.py
```

- `ZERORUNTIME_AUTH_TOKEN`: the token the worker joins a room with when the dispatch does not carry one.
- `ZERORUNTIME_AGENT_ID`: the id the worker registers under. It must equal `STUDIO_VOICE_AGENT_ID`.
- `ZERORUNTIME_FPS`: optional control rate in Hz, default `30`.
- `voice/.env` is loaded on import if it exists (`voice/config.py`).

To build the container, run this from the repo root with BuildKit, which reads `studio/agent/Dockerfile.dockerignore`:

```bash
docker build -f studio/agent/Dockerfile -t studio-voice .
docker run -e ZERORUNTIME_AUTH_TOKEN=... -e ZERORUNTIME_AGENT_ID=... studio-voice
```

The image copies `voice/`, `studio/public/sim/` and `studio/agent/`, runs as the unprivileged `worker` user, and bakes
in no secret.

Worker tests run from the repo root. `studio/agent/requirements.txt` does not include pytest, so install it first:

```bash
pip install pytest
python -m pytest studio/agent/tests -q
```

Offline mode (`NEXT_PUBLIC_STUDIO_OFFLINE=1`) has no server to ask, so Voice is always disabled there; the e2e suite
turns it on with the test-only hook `window.__studio.setVoiceAvailable(true)` (needs `NEXT_PUBLIC_STUDIO_TEST_HOOKS=1`).

### Developer path: drive the robot from Python

```bash
pip install -r requirements.txt
export ZERORUNTIME_AUTH_TOKEN=...      # a token for the same account
export ZERORUNTIME_MEETING_ID=...      # the room id Studio shows
python leader.py
```

`leader.py` is an ordinary `zeroruntime-teleops` Leader. It claims control of the tab, holds the deadman and
waves `shoulder_pan`. Ctrl-c releases the deadman and the arm holds where it is. A key press in the tab takes
control back.

## Configuration

All server-side; none of it reaches the browser. See `.env.example`.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `ZERORUNTIME_API_KEY` | yes | | VideoSDK API key of the account that owns the Studio rooms. |
| `ZERORUNTIME_SECRET` | yes | | Matching API secret; signs every token. |
| `STUDIO_VOICE_AGENT_ID` | no | unset | Id of the Zero Runtime voice agent dispatched into a room. Unset: Voice is disabled in the UI and `POST /api/voice` answers 503 `voice_unavailable`. |
| `ZERORUNTIME_API_BASE` | no | `https://api.videosdk.live` | API origin for rooms, agent dispatch and the dashboard profile. |
| `REDIS_URL` | no | in-memory | Redis for rate limits, issued rooms and the voice queue. Empty means an in-process store: one process, dev only. Use Redis with more than one replica. |
| `STUDIO_SESSION_SECONDS` | no | `300` | Session length; the join token lives 60 s longer. |
| `STUDIO_VOICE_MAX_CONCURRENT` | no | `5` | Voice sessions at once; further visitors are queued. |
| `STUDIO_SESSIONS_PER_IP_PER_HOUR` | no | `10` | Sessions one IP may start per hour before a 429. |
| `STUDIO_TRUSTED_PROXY_HOPS` | no | `1` | **Deployment requirement.** Number of reverse proxies in front of Studio that append the client address to `x-forwarded-for`. The per-IP limit trusts only the entry that many places from the end. Each proxy must append the address it sees, not pass the client's header through, or the limit can be dodged by forging the header. |

Build-time flags (inlined into the browser bundle, so they are Docker build args, not runtime env):

| Variable | Meaning |
|---|---|
| `NEXT_PUBLIC_STUDIO_OFFLINE=1` | Skip the room and `/api/session`; the sim runs standalone. |
| `NEXT_PUBLIC_STUDIO_TEST_HOOKS=1` | Install `window.__studio` for e2e. Never set it in production. |

## Architecture

```
Visitor's browser tab
├── Sim worker (Web Worker)
│     MuJoCo WASM ── physics step ──┐
│     FollowerCore (Rust → WASM) ◀──┤ gates, lease, deadman, clamp, slew, e-stop
│     LeaderCore  (keyboard)  ──loopback──▶ FollowerCore
├── Main thread
│     three.js / R3F stage, front + wrist virtual cameras (render targets)
│     js-sdk 1.2.1: data lanes (send / on("data")), pubSub (teleop-v2-*),
│                   front camera as custom webcam track
└── Studio UI (Next.js)
                │
        VideoSDK room (one per visit)
        ├── browser robot  = Follower "studio-so101"
        ├── voice worker   = Zero Runtime agent + VoiceLeader (Python)  ← dispatched per room
        └── (developer)    = any Python Leader, e.g. leader.py

Studio server (Next.js route handlers): create room, mint short-lived token,
dispatch voice agent, rate limits. Secrets server-side only.
```

Full design: [`../docs/superpowers/specs/2026-10-21-zeroruntime-studio-design.md`](../docs/superpowers/specs/2026-10-21-zeroruntime-studio-design.md).

```
src/app/      pages and route handlers (/tabletop, /api/session, /api/voice, /api/me)
src/sim/      scene, IK, jog, joint mapping (pure TypeScript, unit tested)
src/robot/    the Web Worker and its host: MuJoCo + FollowerCore
src/room/     VideoSDK room transport for the teleop wire protocol
src/server/   env, tokens, VideoSDK client, rate limits and store
src/ui/       workspace, stage, voice panel, developer drawer
public/sim/   vendored MJCF scene, meshes and textures (see NOTICE)
```

## Tests

```bash
npm test             # vitest unit tests
npm run lint
npm run typecheck
npm run e2e          # Playwright; starts its own offline dev server on :3111
```

Install the browser once with `npx playwright install chromium`. The e2e suite includes the Stop timing check
(the arm must stop within 300 ms, measured by the e2e probe in `e2e/drive.spec.ts` from the Space keydown to
the E-STOPPED pill). That budget assumes the stage renders on
a GPU: Playwright config launches the real Chromium with Metal on macOS, and elsewhere WebGL falls back to
SwiftShader, which is several times slower and can miss the 300 ms budget on a machine with no GPU.

## Container

The image build cannot reach the sibling checkout, so first copy the tarball into the build context
(Docker only; `npm ci` outside Docker does not use it):

```bash
scripts/vendor-wasm.sh
docker build -t studio .
docker run -p 3000:3000 --env-file .env.local studio
```

Multi-stage `node:20-slim`, Next `output: "standalone"`, listens on 3000 as the unprivileged `node` user, no
secrets baked in. For the offline demo build, add `--build-arg NEXT_PUBLIC_STUDIO_OFFLINE=1`. `next build`
fetches Google Fonts through `next/font/google`, so the build needs network access. Remember
`STUDIO_TRUSTED_PROXY_HOPS` and `REDIS_URL` for any deployment behind a proxy or with several replicas.

## Temporary dependency

`@zeroruntime/teleops-wasm` (the WASM build of the teleop core, built in the private `videosdk-rust-sdk` repo)
is not on npm yet. `package.json` points at a local `npm pack` tarball outside this repo
(`file:../../../../videosdk-rust-sdk/.worktrees/feat-teleop-wasm/.../zeroruntime-teleops-wasm-<version>.tgz`),
so a fresh clone cannot `npm ci` without that sibling checkout.

For Docker, `scripts/vendor-wasm.sh` copies the tarball into `studio/vendor/` (gitignored, never committed) and
the Dockerfile rewrites the path in `package.json` and `package-lock.json` inside the image. Once the package
is published, replace the `file:` spec with the registry version, regenerate the lockfile, and delete
`scripts/vendor-wasm.sh`, `vendor/` and the `sed` line in the Dockerfile.

## Licences and attribution

The simulation assets under `public/sim` are derived from Apache-2.0 works (MuJoCo Menagerie
`robotstudio_so101`, LeRobot EnvHub `so101-tabletop-mujoco`). Attribution, the changes made and the licence
text are in [`public/sim/NOTICE`](public/sim/NOTICE).
