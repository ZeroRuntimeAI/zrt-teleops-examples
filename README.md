# Zero Runtime teleoperation examples

Runnable examples for [`zeroruntime-teleops`](https://pypi.org/project/zeroruntime-teleops/):
drive a robot arm over the internet from another arm, from your own code, or
from a policy. Live video, safety limits and dataset recording are built in.

[Docs](https://docs.zeroruntime.ai/robotics/overview) ·
[Python SDK reference](https://docs.zeroruntime.ai/robotics/api-reference/python/overview) ·
[Troubleshooting](https://docs.zeroruntime.ai/robotics/guides/troubleshooting) ·
[Discord](https://discord.gg/f2WsNDN9S5)

```
LEADER (drives)                          ROOM                       FOLLOWER (moves)
───────────────                                                     ────────────────
a person on a leader arm  ── joint targets ─────────────────▶   safety gates ─▶ motors
your code, or a policy    ◀── camera video + joint state ─────   cameras, recording
```

Every session has two sides that join the same **room**. The **follower** runs
on the robot. It owns the motors, the cameras, the safety checks and the
recording. The **leader** runs wherever the operator is, which can be another
machine, network or country. It asks for control and streams the pose the
robot should move to.

## Contents

- [Pick an example](#pick-an-example)
- [Key terms](#key-terms)
- [Get started](#get-started): requirements, credentials, install, first run
- [Configuration](#configuration)
- [Safety](#safety)
- [Build your own](#build-your-own)
- [Troubleshooting](#troubleshooting)

## Pick an example

| Example | Hardware | Machines | Platform | What it shows |
|---|---|---|---|---|
| [`quickstart/`](quickstart/) | none (webcams optional) | 1 or 2 | Linux, macOS | A full session with simulated arms on both ends |
| [`so101/`](so101/) | 2× SO-101 arms | 1 or 2 | Linux, macOS | Drive a real arm from a real arm, through LeRobot |
| [`inference/`](inference/) | 1× SO-101 + a SmolVLA checkpoint | 2 | Linux, macOS | A policy drives the arm instead of a person |
| [`ros2/`](ros2/) | 2× SO-101 arms | 2 | Ubuntu 24.04 + ROS 2 Jazzy, or Docker on any 64-bit Linux | The `so101/` session, with each arm behind ros2_control |

**Start with `quickstart/`, whatever hardware you have.** It runs the same
session a real rig runs, without the servos. It is the fastest way to confirm
that your token, your room and your network work before an arm is involved.

Each example changes one thing from the one before it:

- **`quickstart/` → `so101/`** replaces the simulated arms with real ones.
  The session code is the same.
- **`so101/` → `inference/`** replaces the person with a model. The robot side
  is unchanged: the follower cannot tell a policy from a human, and applies
  the same limits to both.
- **`so101/` → `ros2/`** keeps the session but puts each arm behind
  ros2_control instead of LeRobot.

## Key terms

| Term | Meaning |
|---|---|
| **Follower** | The robot side. Moves, streams its cameras and joint positions, enforces safety, records. It decides who may drive. |
| **Leader** | The driving side: a leader arm, your code, a VR headset or a policy. Streams joint targets. |
| **Room** | The session both sides join, identified by a room id (`ZERORUNTIME_MEETING_ID`). |
| **Control** | Only one leader drives at a time. The leader calls `claim_control()`, and the follower grants or denies it. |
| **Deadman** | The leader's "I am driving" switch (`hold_deadman(True)`). Release it and the follower stops applying commands. |
| **Watchdog** | If no command arrives for `watchdog_timeout_s` (0.5 s in these examples), the follower holds position. |
| **Slew** | The maximum change per joint per control tick. In effect, a speed limit. |
| **Alignment gate** | Optional check that refuses to arm until the leader's pose is close to the follower's. |
| **Episode** | One recorded segment of a session: one training sample in the exported dataset. |

## Get started

### Requirements

| You run | Python | Install |
|---|---|---|
| `quickstart/` | 3.10+ | `pip install -r requirements.txt` |
| `so101/` | 3.12+ (LeRobot 0.6.1 needs it) | add `pip install "zeroruntime-teleops[lerobot]"` |
| `inference/` | 3.12+ | add `pip install "lerobot[smolvla]"` on top of `so101/` |
| `ros2/` | 3.12, the Python ROS 2 Jazzy runs on | see [`ros2/README.md`](ros2/README.md#needs) |

| OS | Architecture |
|---|---|
| Linux | x86_64, aarch64 (Raspberry Pi, Jetson) |
| macOS | arm64 |

### 1. Get a token and a room id

Every example needs two values. Both ends of a session use the same ones.

| Variable | What it is | Where it comes from |
|---|---|---|
| `ZERORUNTIME_AUTH_TOKEN` | Your access token. It is a bearer credential, so keep it out of git. | [The dashboard](https://app.videosdk.live/signup) |
| `ZERORUNTIME_MEETING_ID` | The room both ends join | Created once, with the command below |

Rooms are created through the API. An id you invent is rejected. After you
install (step 2), create one:

```bash
export ZERORUNTIME_AUTH_TOKEN="your-token"
python -c "from zeroruntime.teleops.rooms import create_room; print(create_room())"
```

It prints a room id like `abcd-efgh-ijkl`. Reuse it for as long as you like.

### 2. Install

```bash
git clone https://github.com/ZeroRuntimeAI/zrt-teleops-examples.git
cd zrt-teleops-examples

python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt          # enough for quickstart/
```

For the hardware examples, add the extras from the [requirements table](#requirements).
`ros2/` installs into the Python that ROS 2 runs on, not this venv.

### 3. Run the quickstart

No robot is needed. Use two terminals on one machine, or one terminal on each
of two machines.

```bash
cd quickstart
cp .env.example .env          # then paste your token and room id into .env

python follower.py            # terminal 1: the robot side
python leader.py              # terminal 2: the operator side
```

The leader prints `armed. ctrl-c to stop.`, then a `tick` line every second
showing the follower's joints. `shoulder_pan` should swing back and forth.
Press Ctrl-C on the leader: the follower reports `state: holding` and stays
where it is.

[`quickstart/README.md`](quickstart/README.md) explains what each line means
and suggests what to try next.

## Configuration

Each example reads a `.env` file from its own directory (`cp .env.example .env`).
All of them need `ZERORUNTIME_AUTH_TOKEN` and `ZERORUNTIME_MEETING_ID`. The
hardware examples also need each arm's serial port and calibration id. Shell
variables take precedence over `.env`, and `.env` is gitignored.

Other settings are constants in the `── Settings ──` block at the top of each
script. Each example's README lists every variable and setting it uses.

## Safety

- **Slew is the speed limit**: the maximum move per joint per tick (12 at 30 Hz = 360 units/s). Use `2.0` for a first run with an untested policy.
- **Stopping the leader is always safe.** Ctrl-C releases the deadman, and the follower holds its pose.
- **Stopping the follower in `ros2/` cuts torque**, so a loaded arm can sag. Use `follower_leave` instead. In `so101/` and `inference/`, the motors stay powered.
- **The alignment gate ships off**, so the follower jumps to the leader's pose the moment you arm. Line the arms up first, or set `ALIGN` (e.g. `20.0` on an SO-101).

## Build your own

The examples are meant to be copied:

| You want to | Start from |
|---|---|
| Connect your own robot: subclass `Follower` ([guide](https://docs.zeroruntime.ai/robotics/integrations/custom)) | [`quickstart/follower.py`](quickstart/follower.py) |
| Drive from your own input device: subclass `Leader` | [`quickstart/leader.py`](quickstart/leader.py) |
| Drive from a model: replace `load_policy()` | [`inference/smolvla_leader.py`](inference/smolvla_leader.py) |
| Drive an SO-101 through LeRobot or ROS 2 | [`so101/`](so101/), [`ros2/`](ros2/) |

Rules that apply to anything you build:

1. Both ends declare the same joints and units, or `claim_control()` returns `False`.
2. In a `Follower` or `Leader` subclass, call `super().__init__()` last.
3. Never block in `read_joints()` / `write_joints()`. Put slow work on its own thread.
4. Let hardware failures raise. The follower then stops the arm.

API reference: [Follower](https://docs.zeroruntime.ai/robotics/api-reference/python/follower) ·
[Leader](https://docs.zeroruntime.ai/robotics/api-reference/python/leader) ·
[SafetyConfig](https://docs.zeroruntime.ai/robotics/api-reference/python/safety-config)

## Troubleshooting

| Symptom | Fix |
|---|---|
| `no control` / `no lease` | Start the follower first, with the same `ZERORUNTIME_MEETING_ID` on both ends. Pair scripts from the same example |
| Join fails with 404 or `RoomError` | Create the room with [`create_room()`](#1-get-a-token-and-a-room-id) |
| Follower shows `holding (starvation)` | The leader stopped sending. Check it is running and the network is up |

Each example's README covers its own problems. Still stuck? See the
[troubleshooting guide](https://docs.zeroruntime.ai/robotics/guides/troubleshooting),
ask on [Discord](https://discord.gg/f2WsNDN9S5), or
[open an issue](https://github.com/ZeroRuntimeAI/zrt-teleops-examples/issues).
