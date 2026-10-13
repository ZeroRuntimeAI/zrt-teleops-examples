# inference

A SmolVLA policy drives an SO-101 arm instead of a person. The model runs on
one machine, and the arm can be anywhere else.

```
policy machine                               robot machine
──────────────                               ─────────────
smolvla_leader.py  ── joint targets ──────▶  follower.py ─▶ SO-101
                   ◀── video + joints ─────  cameras
```

The robot side is the same follower a human uses, with the same safety
limits. It does not know a model is driving.

## Needs

- One calibrated SO-101 with its cameras. Get it working with a person
  driving first, in [`so101/`](../so101/).
- Python 3.12+ and `pip install "zeroruntime-teleops[lerobot]" "lerobot[smolvla]"`.
- A GPU on the policy machine is recommended. CPU works, but slower.
- A token and a room id: [root README, step 1](../README.md#1-get-a-token-and-a-room-id).

## Setup

**1. Fill in `.env`** on each machine (`cp .env.example .env`):

| Variable | Machine | Value |
|---|---|---|
| `ZERORUNTIME_AUTH_TOKEN`, `ZERORUNTIME_MEETING_ID` | both | Your token and room id, the same on both |
| `ZERORUNTIME_FOLLOWER_PORT`, `ZERORUNTIME_FOLLOWER_ID` | robot | The arm's serial port and calibration id |
| `ZERORUNTIME_POLICY_PATH` | policy | The checkpoint directory (it contains `config.json`) |
| `ZERORUNTIME_TASK` | policy | The task the checkpoint was trained on, word for word |

**2. Get a checkpoint.** Any SO-101 SmolVLA fine-tune works. To try a
community one:

```bash
hf download un1c0rnio/smolvla_so101_box_pencil4_100000 --local-dir ./ckpt
python -m lerobot.processor.migrate_policy_normalization --pretrained-path ./ckpt
# then set ZERORUNTIME_POLICY_PATH=./ckpt_migrated
```

A borrowed checkpoint won't do your task, but it proves the whole loop works.

**3. Match the camera names.** Set `CAMERA_LABELS` at the top of
`follower.py` to the names the checkpoint expects, in the right order. The
leader prints them when it loads, for example `cameras ['camera1', 'camera2']`.

## Run

Set `SLEW = 2.0` at the top of `follower.py` for a first run, so the arm moves
slowly. Then:

```bash
python follower.py          # on the robot machine, first
python smolvla_leader.py    # on the policy machine
```

The leader prints `armed, the policy is driving.` Press Ctrl-C to stop it. The
arm holds where it is.

**Arming.** By default (`ALIGN = None` in `smolvla_leader.py`), the arm moves
to the policy's first output as soon as it arms. Set `ALIGN` to a number to
wait until the arm is that close instead. With a borrowed checkpoint the
policy's pose may be too far away to ever line up. In that case, move the arm
closer by hand, or leave `ALIGN = None` and keep `SLEW` low.

To record runs, set `RECORD = True` in `follower.py`. Recordings go to the
cloud (billed), and a local copy is saved under `./sessions`.

## Use your own model

Copy [`smolvla_leader.py`](smolvla_leader.py) and replace `load_policy()`. It
must return `predict(images, state) -> {joint: value}`. Inference already runs
on its own thread, so a slow model just updates the arm less often.

## Troubleshooting

| Problem | Fix |
|---|---|
| `no config.json in ...` | Point `ZERORUNTIME_POLICY_PATH` at the folder containing `config.json` |
| `... is a pre-0.6 checkpoint` | Run the `migrate_policy_normalization` command it prints, then use the `_migrated` folder |
| `checkpoint outputs N actions but this robot has 6 joints` | Use an SO-101 checkpoint |
| Armed, but the arm doesn't follow the policy | The camera names don't match. Fix `CAMERA_LABELS` |
| `never armed: gave up after 60s` | See **Arming** above |
| `no control: no follower answered` | Start `follower.py` first, with the same room id |

For port, calibration and power problems, see [`so101/`](../so101/README.md#troubleshooting).
