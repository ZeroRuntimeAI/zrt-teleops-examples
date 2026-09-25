# so101

Two SO-101 arms, two machines, one room. Each side wraps an ordinary lerobot
`Robot`/`Teleoperator` in an adapter that owns the network session.

```
follower host                            leader host
─────────────                            ───────────
SO101Follower (robot=)                   SO101Leader (teleop=)
        │                                        │
        ▼                                        ▼
SO101FollowerAdapter  ─── video + joints ──▶  SO101LeaderAdapter
                      ◀── actions ──────────
```


## Needs

- Two SO-101 arms, calibrated
- `pip install "zeroruntime-teleops[lerobot]"` (lerobot 0.6.1+, Python 3.12+)
- A room id and a token, the same on both hosts

## Setup

```bash
cp .env.example .env
```

Then open `.env` and fill it in.

One copy per host. The session lines match on both; the hardware lines do
not, and a host running only one side leaves the other's blank.

Both arms on one machine works too — fill in all four hardware lines and
run the two scripts in separate terminals. They must be different ports;
the script stops if they are not. That is the setup where `/dev/ttyACM*`
numbering matters most, since which arm is `ACM0` follows enumeration
order and can change after a replug or reboot. `lerobot-find-port` tells
them apart by having you unplug one.

First time on a rig:

```bash
lerobot-find-port
lerobot-calibrate
lerobot-find-cameras opencv
```

`lerobot-find-port` tells you which serial port is which arm.
`lerobot-calibrate` runs once per arm. `lerobot-find-cameras` shows what
each camera is looking at.

`ZRT_FOLLOWER_ID` and `ZRT_LEADER_ID` are lerobot calibration ids, which are
filenames: `lerobot-calibrate` writes `<id>.json` and lerobot reads each
joint's range from it. Leave one blank and the script lists what you have.

## Run

On the machine with the follower arm:

```bash
python follower.py
```

On the machine with the leader arm:

```bash
python leader.py
```

Ctrl-c on the leader releases the deadman: the far arm holds position, it
does not fall.

Settings are a block at the top of each script rather than command-line
flags. In `leader.py`, `ALIGN` is the one to know: it refuses to arm while
any joint is further than that from the follower's. Keep it — without a
gate, a leader arm resting somewhere else makes the far arm travel to meet
it at full slew the instant you arm. Set it to `None` to arm immediately.

Arming is a *hold*, not a keypress: the leader is backdrivable, so
releasing it to press a key drops the arm.
