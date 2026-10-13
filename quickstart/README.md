# quickstart

A full teleoperation session with no robot. Both arms are simulated; the room,
the safety checks and the video from your webcams are real.

```
leader.py                                    follower.py
─────────                                    ───────────
FakeLeader     ── joint targets ──────────▶  FakeFollower (6 simulated joints)
               ◀── video + joints ─────────  your webcams (optional)
```

If this works, your token, room and network are ready for a real arm.

## Needs

- Python 3.10+ and `pip install -r requirements.txt` from the repo root.
- A token and a room id: [root README, step 1](../README.md#1-get-a-token-and-a-room-id).

## Run

```bash
cd quickstart
cp .env.example .env        # fill in ZERORUNTIME_AUTH_TOKEN and ZERORUNTIME_MEETING_ID

python follower.py          # terminal 1: the robot side, start it first
python leader.py            # terminal 2: the operator side
```

Both scripts can run on one machine, or on two machines on different networks
with the same `.env`.

**What you should see:** the leader prints `armed. ctrl-c to stop.`, then a
`tick` line every second. In it, `shoulder_pan` swings between about −60 and
+60. The follower prints `control granted` and `state: active`.

Now press Ctrl-C on the leader. The follower reports `state: holding` and
stays where it is. That's how a real arm behaves when the operator disconnects.

## Things to try

Edit the constants at the top of each script:

- `SLEW = 0.5` in `follower.py`: the follower can't keep up with the sweep.
  This is the speed limit at work.
- `MAX_CAMERAS = 0` in `follower.py`: joints only, no video.
- `SWEEP`, `SWEEP_HZ` in `leader.py`: a bigger or faster motion.

To connect your own robot or input device, start from these two files. See
[Build your own](../README.md#build-your-own).

## Troubleshooting

| Problem | Fix |
|---|---|
| `no control: ... never answered` | Start `follower.py` first, with the same room id in both `.env` files |
| `cameras need opencv` | `pip install opencv-python`, or set `MAX_CAMERAS = 0` |
| macOS: a camera won't open | Allow camera access for your terminal in System Settings → Privacy & Security → Camera |

## Next

[`so101/`](../so101/) for real arms, [`inference/`](../inference/) to let a
model drive, or [`ros2/`](../ros2/) for ROS 2.
