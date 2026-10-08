# zrt robotics examples

Runnable teleoperation examples. One robot moves, one thing drives it, and a
room in between carries the video one way and the actions the other.

| Directory | Needs | What it shows |
|---|---|---|
| [`quickstart/`](quickstart/) | a room id and a token | both ends of a real session, with no arm on either end |
| [`so101/`](so101/) | two SO-101 arms, lerobot, two hosts | driving a real arm from a real arm, over the internet |
| [`inference/`](inference/) | one SO-101, plus a SmolVLA checkpoint | a policy driving the arm instead of a person |
| [`ros2/`](ros2/) | two SO-101 arms, ROS 2 Jazzy on Ubuntu 24.04 | the `so101/` session with ros2_control on each arm |

Start with `quickstart/` whatever hardware you have. It is the same session a
real rig runs, minus the servos, so it is the fastest way to find out whether
your token, your room and your network are right before an arm is involved.

The three build on each other. `so101/` swaps the fake arm for a real one
and changes nothing else; `inference/` swaps the human for a model and
changes nothing on the robot side at all — its follower is the same
follower, and does not know a policy is driving it. `ros2/` is `so101/`
with each arm behind ros2_control instead of lerobot; you drive it with
`take_control`, `release_control`, `start_recording` and the rest of the
commands in [`ros2/README.md`](ros2/README.md#run).

## Install


 For running the `quickstart/`.
```bash
git clone https://github.com/ZeroRuntimeAI/zrt-teleops-examples.git && cd zrt-teleops-examples

python3 -m venv .venv
source .venv/bin/activate

pip install -r requirements.txt
```

 For `so101/`, add the SO-101 adapters:

```bash
pip install "zeroruntime-teleops[lerobot]"
```

For `inference/`, add SmolVLA on top of that:

```bash
pip install "lerobot[smolvla]"
```

`so101/` and `inference/` need Python 3.12 or newer.

For `ros2/`, install into the Python ROS 2 Jazzy uses, not this venv —
[`ros2/README.md`](ros2/README.md#needs) has the details:

```bash
pip install "zeroruntime-teleops[ros2]"
```

| OS    | Architecture     |
|-------|------------------|
| Linux | x86_64, aarch64  |
| macOS | arm64    |


## Credentials

Every directory ships a `.env.example`. Copy it:

```bash
cd quickstart
cp .env.example .env
```

Then open `.env` and fill it in.

The scripts load `.env` from their own directory, so there is nothing to
`source` and it does not matter where you run them from. Anything already
set in your shell wins over the file. `.env` is gitignored — a room token is
a bearer credential.

The two every example needs are `ZERORUNTIME_AUTH_TOKEN` and `ZERORUNTIME_MEETING_ID` (in
`ros2/`, the SDK's own `ZERORUNTIME_AUTH_TOKEN` and
`ZERORUNTIME_MEETING_ID`, since the ROS node reads them itself), and both
ends of a session must use the same room id.

Other settings live at the top of each script — open the file and edit
them.

## Safety, in one place

Each example says this where it matters, but it is the same three facts
every time.

- **`slew` is a speed limit in disguise.** It caps how far one joint moves
  in a single tick, so at 30 Hz a slew of 12 is 360 units/s. It is the first
  number to re-derive on your own hardware, and `ZERORUNTIME_SLEW=2.0` is the
  setting for a first run with a policy you have not watched before.
  In `ros2/` it is `max_norm_step` in `bridge.yaml`, a fraction of each
  joint's range per tick.
- **Ctrl-c is a real stop.** It releases the deadman, the command stream
  ends, the follower's watchdog runs out and the arm holds where it is. It
  does not fall, and it does not depend on the thing that was driving it
  agreeing to stop. In `ros2/` this holds for the leader, but Ctrl-c on the
  follower's `ros2 launch` also stops the servo driver: torque goes off and
  only the gears hold the arm, so a loaded pose can sag. `follower_leave`
  leaves the room with the arm actively holding.
- **Arm against a gate.** `ALIGN`, at the top of each leader script,
  refuses to arm until the robot is near the leader's pose. Without it,
  anything standing somewhere else makes the arm travel to meet it the
  instant you arm. In `ros2/` the gate is `max_misalignment` in
  `bridge.yaml`, shipped at 0.0 (off): `take_control` makes the follower
  travel to the leader at the `max_norm_step` limit.
