# voice

Talk to a robot arm. You speak in a browser, a Zero Runtime voice agent
works out what you mean, and an SO-101 does it: "open your gripper",
"wave, then go home", "what do you see?".

```
browser                    this machine                          robot machine
───────                    ────────────                          ─────────────
your mic   ── speech ───▶  agent.py                              so101/follower.py
robot cam  ◀── video ────    voice agent: STT → LLM → tools        SO-101 + cameras
event log  ◀── events ───    teleops leader ── joint targets ──▶   slew, watchdog, hold
STOP       ── stop ─────▶                   ◀── video + joints ─
```

Everything joins one room. The voice agent and the teleops leader run in the
same process, so a tool moves the arm with a plain method call. The robot side
is the unchanged [`so101/`](../so101/) follower: it can't tell a voice agent
from a person, and applies the same limits to both.

## Needs

- One calibrated SO-101 follower, working with [`so101/`](../so101/) first.
- Python 3.12+ and `pip install "zeroruntime-teleops[lerobot]>=0.1.2" "zeroruntime>=0.1.8"`.
- A token and a room id ([root README, step 1](../README.md#1-get-a-token-and-a-room-id)).
  One token drives the room and the agent.
- A browser with a microphone.

## Setup

1. In `so101/.env`, set the follower's port and calibration id as usual, and the room id.
   To publish only the arm's cameras, not your laptop's, set `TELEOP_CAMERAS` to
   the labels `follower.py` prints, e.g. `TELEOP_CAMERAS=cam1,cam2`.
2. Here: `cp .env.example .env`, then set the same token and room id.
   `ZERORUNTIME_TARGET` is optional; blank means `us2.zeroruntime.ai`.

## Run

```bash
python ../so101/follower.py      # on the robot machine, first
python agent.py                  # here
```

Or both at once with [`demo.sh`](#running-both-sides-with-demosh).

`agent.py` prints a link. Open it, click **Join and talk**, allow the mic,
and say "open your gripper".

| Say | Tool |
|---|---|
| "Open your gripper", "close it halfway" | `set_gripper` |
| "Turn left a bit", "raise your arm", "rotate your wrist" | `move_joint` |
| "Go home", "wave hello", "nod", "point left" | `perform` |
| "Dance", "dance to this", "do a robot dance" | `dance` |
| "Is your gripper open?" | `get_robot_state` |
| "What do you see?" | `look` |
| "Stop" | `stop` |
| "Pick up the red cube", "put it in the box" | `pick_up`, `place`: experimental |
| (after an interruption) | `wait_for_robot` |

The page shows what it heard, each tool it called (✓ or ✗ with the reason),
and the arm's joints.

## Language

Hindi is the default (`ZERORUNTIME_LANGUAGE=hi`): Deepgram's Hindi model hears
Hindi, English and Hinglish ("gripper खोलो"), Sarvam speaks, and the agent
answers in whichever you spoke. Set `ZERORUNTIME_LANGUAGE=en` for English
only, with Deepgram and Cartesia.

## Multi-step goals

The agent is the robot, and it speaks as one: "I'm opening my gripper". Give
it a goal with several parts, "pick up the cube and put it in the box", and it
plans the steps, then for each one acts, looks through its camera to check,
and moves on. A step that fails is retried up to 3 times. If it stops before
the goal is done, it asks "Shall I continue with …?". Say yes.

If its body is the problem, it says what is wrong instead of retrying:

| It says | Check |
|---|---|
| "I'm not connected to my arm's controller" | The follower restarted: restart it, then `agent.py` |
| "My servos report a fault" | The arm's power and USB cable |
| "I'm not getting position updates" | The follower is down, or its network |
| "My elbow didn't reach where I sent it" | Something blocks the arm, or its torque is off |

## Dancing

Say "dance". Without music it dances on its own for about 20 seconds, and
music that starts meanwhile takes over the beat. The page hears the beat
through your mic (nothing leaves the page but the tempo, the beat time and
the loudness), and the arm dances on it until the music stops. No two dances
are the same: each phrase is drawn fresh, weighted by a mood the agent picks
(energetic, smooth, robotic, playful), and louder music means bigger moves.

While music plays, the page pauses your mic so the agent doesn't answer the
lyrics. To talk over a song ("dance to this", "something smoother"), click
**Mic on**: it stays on until the music stops. STOP and Space always work,
and the mic comes back when the music stops. Beats travel over the network,
so the arm is on the beat, not sample-accurate.

Dancing needs a faster follower: `ZERORUNTIME_SLEW=5.0` in `so101/.env`.

The link carries your token. The page is served on localhost only, but don't
paste the link anywhere public.

## Stopping

Any of these stops the arm where it is, and the follower holds it:
say "stop" · press **STOP** (or Space) on the page · Ctrl-C `agent.py` ·
lose the network (the follower's 0.5 s watchdog).

The hard stops are Ctrl-C on the follower, or the arm's power switch.
Stopping the follower turns the motors' torque off, so the arm goes limp:
rest it first.

## Experimental: pick-up

`pick_up` and `place` hand the arm to [MolmoAct2](https://huggingface.co/allenai/MolmoAct2-SO100_101),
the one public checkpoint trained on SO-100/101 arms, for up to 30 s. Without
fine-tuning on your scene it often misses, and the agent is told to say so.

```bash
pip install transformers pillow
```

Set `ZERORUNTIME_PICKUP=1` in `.env`. `place` uses the same model. The first start downloads
21.8 GB. On an M5 MacBook Pro (24 GB) it takes about 2 minutes to load and
warm up, uses about 14 GB of memory, and plans 30 steps in about 1.3 s.

## Running both sides with demo.sh

```bash
./demo.sh up       # the follower, then the agent; opens the page
./demo.sh status   # what runs where, faults, log paths, the page link
./demo.sh logs     # follow the agent, its events and the follower
./demo.sh down     # the agent; the follower keeps holding the arm
./demo.sh down all # the follower too: torque goes off, so rest the arm first
```

`demo.sh` starts the follower on this machine, or over ssh on another one
when `.env` sets `ROBOT_HOST` (plus `ROBOT_DIR` and `ROBOT_PYTHON` there).

| Log | Where |
|---|---|
| Agent output | `voice/logs/agent-<time>.log` (`agent-latest.log`) |
| Events: heard, tools and timings, pick-up inferences, dance phrases | `voice/logs/events-<time>.jsonl` |
| Follower output | `~/voice-demo/logs/follower-<time>.log` on the robot machine |

When something goes wrong, send the output of `./demo.sh status` and the
events file. Between them they show what was heard, what ran, how long it
took, and what the robot reported.

## Make it yours

- **Poses and gestures** are data in `skills.py`. Capture a pose by hand with
  `python capture_pose.py` (stop the follower first), paste it into `POSES`,
  and add its name to the `perform` docstring in `agent.py`.
- **Limits:** `skills.LIMITS` clamps every target. Tighten it for your table.
- **Speed:** `SPEED` in `motion.py`. Lower `ZERORUNTIME_SLEW` in `so101/.env`
  for a first run.
- **A new ability** is a `@function_tool` method on `RobotAgent`. Its
  docstring is what the model reads, so say what it does and when to use it.

## Troubleshooting

| Problem | Fix |
|---|---|
| `no control in <room>` | Start `../so101/follower.py` first, with the same room id in both `.env` files |
| `pick-up is off on this machine` | Set `ZERORUNTIME_PICKUP=1` in `.env`, then restart `agent.py` |
| The arm doesn't dance to the music | The page's log says "music heard" once it has a steady beat for 2 s: play it louder, nearer the mic |
| `no ZeroRuntime is listening at ...` | Check `ZERORUNTIME_TARGET` in `.env`, or leave it blank for the default |
| Nothing happens after **Join** | Allow microphone access; check the browser console |
| It hears you but the arm doesn't move | Read the page's log: a ✗ line says why, e.g. no joint state yet |
| A joint moves the wrong way | Fix the direction words in the `move_joint` docstring in `agent.py` |
| `look` describes your desk, not the arm's view | Set `TELEOP_CAMERAS` in `so101/.env`, and keep your own camera off |
| `port 8000 is busy` | Set `ZERORUNTIME_WEB_PORT` in `.env` |

For port, calibration and power problems, see [`so101/`](../so101/README.md#troubleshooting).
