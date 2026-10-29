# ros2

Two SO-101 arms on ROS 2 (ros2_control). You move the leader arm by hand, and
the follower copies it over the internet. One machine per arm.

```
leader machine                                         follower machine
──────────────                                         ────────────────
SO-101 ─▶ /leader/joint_states                         /follower/forward_controller/commands ─▶ SO-101
                │                                                   ▲
                ▼                                                   │
        zrt-teleops-ros2-leader  ── joint targets ───▶  zrt-teleops-ros2-follower
                                 ◀── video + joints ──
```

This is the [`so101/`](../so101/) session, with ROS drivers owning the arms.
The bridge reads and writes ordinary joint topics, so the same pattern works
for any ROS 2 robot.

## Needs

- Two SO-101 arms, calibrated with `lerobot-calibrate`.
- Ubuntu 24.04 with ROS 2 Jazzy. On another Linux, use [Docker](#docker-any-64-bit-linux).
- A token and a room id: [root README, step 1](../README.md#1-get-a-token-and-a-room-id).

On each machine:

```bash
sudo apt install ros-jazzy-ros2-control ros-jazzy-ros2-controllers \
    ros-jazzy-controller-manager ros-jazzy-feetech-ros2-driver \
    ros-jazzy-xacro ros-jazzy-robot-state-publisher ros-dev-tools python3-venv
python3 -m venv --system-site-packages ~/ros2-venv   # sees ROS's rclpy; conda/pyenv won't
source ~/ros2-venv/bin/activate
pip install "zeroruntime-teleops[ros2]"
sudo usermod -aG dialout $USER                       # serial access; log out and back in
```

## Setup

On each machine:

```bash
git clone https://github.com/ZeroRuntimeAI/zrt-teleops-examples.git ~/zrt-teleops-examples
cd ~/zrt-teleops-examples/ros2
cp .env.example .env
source /opt/ros/jazzy/setup.bash
rosdep install --from-paths . --ignore-src -y
colcon build --symlink-install
```

In `.env`, set your token and room id (the same on both machines), plus this
machine's arm:

- **Port:** a `/dev/serial/by-id/...` path (run `ls /dev/serial/by-id/`). It
  survives a replug.
- **Calibration id:** its JSON must be under
  `~/.cache/huggingface/lerobot/calibration/`.

## Run

Each machine uses two terminals.

**1. Launch terminal.** This starts the arm and joins the room. Use
`leader.launch.py` on the leader machine:

```bash
cd ~/zrt-teleops-examples/ros2
source /opt/ros/jazzy/setup.bash && source install/setup.bash
source ~/ros2-venv/bin/activate
set -a; source .env; set +a
ros2 launch so101_teleop_bringup follower.launch.py
```

Wait for the `topics: ...` line.

**2. Command terminal**, on the leader machine. Line the arms up first:
the follower jumps straight to the leader's pose.

```bash
cd ~/zrt-teleops-examples/ros2 && source env.sh
take_control              # start driving
release_control           # stop; the follower holds
```

> **Careful:** Ctrl-C in the *follower's* launch terminal turns the servos'
> torque off, and a loaded arm can drop. Support it first, or run
> `follower_leave` to leave with the arm still holding.

## Commands

Run these after `source env.sh`. A command for one machine refuses to run on
the other.

| Command | Machine | What it does |
|---|---|---|
| `take_control` / `release_control` | leader | Start / stop driving |
| `estop` / `clear_estop` | either | Emergency-stop the follower / release it |
| `start_recording` / `stop_recording` | follower | Record to the cloud (billed), with a local copy in `./sessions` |
| `start_episode ["task"]` / `end_episode [success\|fail]` | either | Mark episodes while recording |
| `follower_leave` / `follower_join` | follower | Leave the room with the arm holding / rejoin |
| `leader_leave` / `leader_join` | leader | Leave the room / rejoin |

Cameras: the follower streams every USB camera. To choose, run
`python -m zeroruntime.teleops.devices` and copy the `ZERORUNTIME_CAMERAS=...`
line it prints into `.env`.

Tuning lives in [`bringup/config/bridge.yaml`](bringup/config/bridge.yaml).
`max_norm_step` is the follower's speed limit, and `max_misalignment` (default
`0.0`, off) makes `take_control` wait until the arms line up.

[`env.sh`](env.sh) has more commands: running in the background
(`follower_up`), testing without arms (`follower_mock`, `fake_leader`), and
watching events (`follower_events`).

## Policy mode

A policy can drive instead of the leader arm. It publishes
`trajectory_msgs/JointTrajectory` chunks (six joints, radians) to
`/leader/zrt_teleop_bridge/action_chunk`. To try it on the leader machine:

```bash
source env.sh
policy_up                 # the leader bridge, without an arm
take_control
fake_chunk 0.3            # a test chunk: shoulder_pan moves to 0.3 rad
```

## Docker (any 64-bit Linux)

The same setup in a container, for Raspberry Pi OS, Debian, Jetson and others
(`arm64` or `amd64`).

```bash
curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER   # then log out and in
git clone https://github.com/ZeroRuntimeAI/zrt-teleops-examples.git ~/zrt-teleops-examples
cd ~/zrt-teleops-examples/ros2
cp .env.example .env      # fill in as in Setup
```

Copy the arm's calibration JSON from where you ran `lerobot-calibrate` to the
same path on this machine: `~/.cache/huggingface/lerobot/calibration/robots/so_follower/<id>.json`
for the follower, or `.../teleoperators/so_leader/<id>.json` for the leader.
Then:

```bash
docker compose pull
docker compose up -d follower       # `leader` on the leader machine
docker compose logs -f follower     # wait for `topics: ...`
docker compose exec follower bash   # command terminal: same commands as above
docker compose stop follower        # same as Ctrl-C: torque off, support the arm first
```

## Troubleshooting

| Problem | Fix |
|---|---|
| `zrt-teleops-ros2-... not found` | `source ~/ros2-venv/bin/activate` |
| `usb_port ... does not exist` | The arm is unplugged. Use its `/dev/serial/by-id/...` path |
| `robot_id is required and empty` | Set the calibration id in `.env` |
| Every servo `Read timeout` | Turn on the arm's power supply |
| `no grant within 5.0s` | The follower isn't in the room. Check its launch terminal and that both `.env` files have the same room id |
| The wrist turns half a turn on `take_control` | The two wrists were calibrated differently. Recalibrate both the same way |
| Join fails with status 404 | The room id doesn't exist. [Create one](../README.md#1-get-a-token-and-a-room-id) |

More in the [SO-101 on ROS 2 guide](https://docs.zeroruntime.ai/robotics/integrations/ros2/so101).
