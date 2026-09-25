# quickstart

Both ends of a real session, with no arm on either end.

```
leader.py                 room                 follower.py
─────────                                      ───────────
set_joints()  ── actions ──────────────────▶   safety gates ─▶ joints
              ◀── video + joint state ─────    observations
```

Same room, same lease, same safety gates a real rig uses. Only the servos
are missing — the cameras are your real ones.

## Setup

```bash
cp .env.example .env
```

Then open `.env` and add your token and room id.

Do this on both machines, with the same `ZRT_MEETING_ID`. No `source`
needed; the scripts read `.env` from this directory.

Cameras need opencv: `pip install opencv-python`.

## Run

Run the robot side in one terminal:

```bash
python follower.py
```

and the operator side in another:

```bash
python leader.py
```

The leader sweeps one joint; the follower's numbers follow it, and its
cameras arrive alongside.

Settings live in a block at the top of each script, not as command-line
flags — open `follower.py` and edit `MAX_CAMERAS` to open fewer
cameras (`0` for none), or `SLEW` to change the speed limit.

Now ctrl-c the leader. The far side stops hearing commands, its watchdog
runs out, and it holds position — it does not fall. Worth seeing once
before a real arm is involved.
