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
| `smolvla_leader.py` | wherever the model runs | a SmolVLA checkpoint, on disk or on the Hugging Face Hub |

## Needs

-    pip install "zeroruntime-teleops[lerobot]" "lerobot[smolvla]==0.6.1" python-dotenv opencv-python-headless
- A room id and a token, the same on both hosts

```bash
cp .env.example .env
```

Then open `.env` and fill it in.

One copy per host: the session lines match, the hardware lines do not.

`ZERORUNTIME_TASK` is required: SmolVLA is language conditioned, and the string has
to match what the checkpoint was trained on.

## Getting a checkpoint

Use [`zero-runtime/smolvla_so101_pick_place_bowl`](https://huggingface.co/zero-runtime/smolvla_so101_pick_place_bowl):
SmolVLA fine-tuned on an SO-101 picking up an orange cube and placing it in
a white bowl.

`smolvla_leader.py` takes the repo id directly and downloads it; there is
nothing to convert:

```
ZERORUNTIME_POLICY_PATH=zero-runtime/smolvla_so101_pick_place_bowl
ZERORUNTIME_TASK=pick up the orange cube and place it in the white bowl
```

The task must be that sentence, word for word: it is the one task the
checkpoint was trained on. The rate (10 Hz) and joint order are read from
its training dataset, `zeroruntime/so101_pick_place_bowl`.

It was trained on three cameras. Set `CAMERA_LABELS` at the top of
`follower.py` to the names they had when it was recorded:

```python
CAMERA_LABELS = ["top", "wrist", "side"]
```

The leader maps them to the checkpoint's `camera1`, `camera2`, `camera3`
by itself. Cameras are labelled in the order they are found, so check the
camera lines the follower prints at startup: if `top` is really the wrist
camera, the policy sees the wrong scene. If a camera is missing, the arm
just holds.

It does this task, on a setup like the one it was recorded on: same
cameras, similar placement, an orange cube and a white bowl. A different
scene or task needs your own fine-tune.

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
flags — `ALIGN` and `SYNC_BUFFER_MS` on the leader, `SLEW`, the camera
format and `RECORD` on the follower. `RECORD = True` records each run to the
cloud (billed); if the cloud is not up within 90 s, it records under
`./sessions` instead. A local copy is kept there either way.

Ctrl-c releases the deadman: the command stream stops, the follower's
watchdog runs out and the arm holds. The model cannot refuse that stop.
