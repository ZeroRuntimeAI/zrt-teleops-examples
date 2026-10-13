# so101

Arm-to-arm teleoperation with two SO-101 arms through LeRobot. You move the
leader arm by hand, and the follower arm copies it, on the same desk or across
the internet.

```
leader machine                               follower machine
──────────────                               ────────────────
leader.py          ── joint targets ──────▶  follower.py ─▶ SO-101
SO-101 (by hand)   ◀── video + joints ─────  cameras
```

Each script wraps an ordinary LeRobot `SO101Leader` / `SO101Follower`, so if
you already use LeRobot, nothing about your arms changes.

## Needs

- Two SO-101 arms with their motor power supplies on. Cameras are optional.
- Python 3.12+ and `pip install "zeroruntime-teleops[lerobot]"`.
- A token and a room id: [root README, step 1](../README.md#1-get-a-token-and-a-room-id).
- On Linux, serial access: `sudo usermod -aG dialout $USER`, then log out and in.

Run [`quickstart/`](../quickstart/) once first. It checks your setup without
risking an arm.

## Setup

**1. Find and calibrate each arm**, once per rig:

```bash
lerobot-find-port       # which port is which arm
lerobot-calibrate       # once per arm; the id you give it goes in .env
```

**2. Fill in `.env`** on each machine (`cp .env.example .env`). Each machine
only fills in the arm it has.

| Variable | Machine | Value |
|---|---|---|
| `ZERORUNTIME_AUTH_TOKEN`, `ZERORUNTIME_MEETING_ID` | both | Your token and room id, the same on both |
| `ZERORUNTIME_FOLLOWER_PORT`, `ZERORUNTIME_FOLLOWER_ID` | follower | The arm's serial port and calibration id |
| `ZERORUNTIME_LEADER_PORT`, `ZERORUNTIME_LEADER_ID` | leader | The same, for the leader arm |
| `ZERORUNTIME_SLEW` | follower | Speed limit, default `12.0`. Use `2.0` to go slowly |

Both arms can be on one machine: fill in all four hardware lines and run each
script in its own terminal.

## Run

**Line the arms up first.** By default, the follower jumps to the leader's
pose at full speed the moment you arm.

```bash
python follower.py      # on the follower machine, first
python leader.py        # on the leader machine
```

The leader prints `armed. the far arm is now tracking your leader.` Move the
leader arm, and the follower copies it. Press Ctrl-C on the leader to stop.
The follower holds its pose and stays powered.

**Safer arming.** Set `ALIGN = 20.0` at the top of `leader.py`. Arming then
waits until every joint of the leader is within 20 of the follower's, and the
leader prints which joint is furthest off. Keep holding the leader while it
arms: if you let go of it, it drops and the follower follows it down.

**Recording.** Set `RECORD = True` at the top of `follower.py`. Each
take-control session becomes one episode, recorded to the cloud (billed),
with a local copy under `./sessions`. See
[Exporting datasets](https://docs.zeroruntime.ai/robotics/guides/exporting-datasets)
to turn recordings into a LeRobot dataset.

## Troubleshooting

| Problem | Fix |
|---|---|
| `..._PORT points at ... which is not there` | The arm is unplugged or was renumbered. Run `lerobot-find-port`; on Linux, use the `/dev/serial/by-id/...` path |
| `set ZERORUNTIME_FOLLOWER_ID` | Use one of the calibration ids it lists, or run `lerobot-calibrate` |
| LeRobot starts calibrating unexpectedly | The calibration id has a typo. Fix it in `.env` |
| `Missing motor IDs`, with every servo missing | Turn on the arm's motor power supply |
| `no lease in <room>` | Start `follower.py` first. Don't pair it with the `quickstart/` leader |
| `never armed` | The leader is too far from the follower's pose. Move it closer, or raise `ALIGN` |
| The second camera won't open | Keep `FOURCC = "MJPG"` in `follower.py` |

More in the [SO-101 guide](https://docs.zeroruntime.ai/robotics/integrations/lerobot/so101).

## Next

[`inference/`](../inference/) to let a model drive, or [`ros2/`](../ros2/) to
run the same arms on ROS 2.
