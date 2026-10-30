# recording

Record a training dataset by teleoperating two SO-101 arms. It is the
[`so101/`](../so101/) session plus recording: episodes are recorded to the
ZeroRuntime cloud, and the leader opens and closes them with single keypresses
while teleop keeps running.

```
follower host                            leader host
─────────────                            ───────────
follower.py  (RECORD = True)             leader.py  (keys: n s f d q)
   episodes ──▶ ZeroRuntime cloud           opens / closes episodes
                                            labels each with ZERORUNTIME_TASK
                       │
                       ▼
          ZeroRuntime dashboard: convert to a dataset, fine-tune
```

## Needs

Everything [`so101/`](../so101/README.md#needs) needs: two calibrated SO-101s,
a room id and a token. Cloud recording is billed to that token's account.

## Setup

```bash
cp .env.example .env
```

Fill it in as for `so101/`. On the leader, also set the task text every episode
gets labelled with. A policy is conditioned on this text, so keep it the same
for a whole batch:

```
ZERORUNTIME_TASK=pick up the cube
```

Cameras are named by the USB port they're plugged into. Set this in
`CAMERA_PORTS` at the top of `follower.py`. Those names become the dataset's
camera keys. The commented-out examples there use pi0.5's own names
(`base_0_rgb`, `left_wrist_0_rgb`, `right_wrist_0_rgb`). Uncomment them and set
your ports, and a pi0.5 run needs no remapping. If the dict is left empty,
cameras are named cam0, cam1… in the order they're found. If a listed camera
is missing, the follower refuses to start, so it can't record views under the
wrong names. `ls /dev/v4l/by-path` shows the ports.

`OBSERVATION_HZ` in `follower.py` sets the dataset's fps (default 10). A policy
trained on the data must run at the same rate.

## Record

On the follower host:

```bash
python follower.py
```

On the leader host:

```bash
python leader.py
```

Then, in the leader's terminal, press single keys (no Enter):

| Key | Does |
|---|---|
| `n` | start a new episode |
| `s` | end it as a success |
| `f` | end it as a failed attempt (kept, `success=false`) |
| `d` | discard it (`success=null`, left out of the dataset) |
| `q` | quit (an open episode is discarded) |

Teleop keeps running between episodes. `s`, `f` and `d` only close the
episode, so you can reset the scene, bring the arm back to rest, and press `n`
for the next one. Ctrl-c works like `q`.

## Convert and fine-tune

Both happen on the ZeroRuntime dashboard. Open the recording there, convert it
to a dataset (e.g. LeRobot), and start a fine-tune from that dataset.