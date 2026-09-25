# inference

A SmolVLA policy drives the arm instead of a person. The model runs here;
the robot is somewhere else.

```
policy host                              robot host
───────────                              ──────────
checkpoint on disk                       SO101Follower
      │                                        │
      ▼                                        ▼
  PolicyLeader   ─── actions ──────────▶  safety gates ─▶ joints
                 ◀── video + joints ───   observations
```

**Nothing on the follower knows a policy is driving.** It is the same
follower a human operator talks to, and applies the same clamps, watchdog
and deadman either way — `so101/follower.py` would work here unchanged.

Two scripts, one per machine, and this directory is self-contained — copy
it and it works.

| | runs on | needs |
|---|---|---|
| `follower.py` | the robot | an SO-101, calibrated, plus its cameras |
| `smolvla_leader.py` | wherever the model runs | a SmolVLA checkpoint on disk |

## Needs

- `pip install "zeroruntime-teleops[lerobot]" "lerobot[smolvla]"`
- A room id and a token, the same on both hosts

```bash
cp .env.example .env
```

Then open `.env` and fill it in.

One copy per host: the session lines match, the hardware lines do not.

`ZRT_TASK` is required: SmolVLA is language conditioned, and the string has
to match what the checkpoint was trained on.

## Getting a checkpoint

SmolVLA is ~0.9 GB, small enough for a Jetson. Any SO-101 fine-tune is the
right shape — 6 actions:

```bash
hf download un1c0rnio/smolvla_so101_box_pencil4_100000 --local-dir ./ckpt
python -m lerobot.processor.migrate_policy_normalization --pretrained-path ./ckpt
# then ZRT_POLICY_PATH=./ckpt_migrated
```

The middle step is needed for most community checkpoints (the script says
so if you skip it) and writes a **new** `_migrated` directory — point at
that one.

Set `CAMERA_LABELS` at the top of `follower.py` to the names the checkpoint
was trained with — SmolVLA checkpoints usually want `camera1`, `camera2`.
Get them wrong and the policy finds no image and the arm just holds; get
their *order* wrong and it sees a wrist view where it expects the scene.

A checkpoint you did not train will not do your task. It proves the loop:
real weights, real latency.

## Run

On the robot:

```bash
python follower.py
```

On the machine running the model:

```bash
python smolvla_leader.py
```

Settings are a block at the top of each script rather than command-line
flags — `ALIGN` and `SYNC_BUFFER_MS` on the leader, `SLEW` and the camera
format on the follower.

Ctrl-c releases the deadman: the command stream stops, the follower's
watchdog runs out and the arm holds. The model cannot refuse that stop.

## Arming

`ALIGN` refuses to arm until every joint is within that of the policy's
first output — without it, a model whose output is far from the arm's
position makes it travel there at full slew the instant you arm.

Inference starts **before** the gate, deliberately: a policy's pose is its
output, and that does not exist until the model has run once.

With a borrowed checkpoint the gate often never opens, because its output
really is that far away:

```
  off by   +87.2 on shoulder_pan
never armed: gave up after 60s waiting for the arms to align
```

That is it working. Move the arm nearer, or set `ALIGN = None` and travel
there slowly — drop `SLEW` to `2.0` in `follower.py` first, which is
60 units/s instead of 360.
