# ros2

Two SO-101 arms on ROS 2 (ros2_control): you move the leader by hand and the
follower copies it over the internet. One machine per arm, or both on one.
Not on Ubuntu 24.04? Use [Docker](#docker-any-64-bit-linux).

## Needs

- Ubuntu 24.04 with ROS 2 Jazzy, two SO-101 arms calibrated with
  `lerobot-calibrate`, and a token and room id (the same on both machines).

```bash
sudo apt install ros-jazzy-ros2-control ros-jazzy-ros2-controllers \
    ros-jazzy-controller-manager ros-jazzy-feetech-ros2-driver \
    ros-jazzy-xacro ros-jazzy-robot-state-publisher ros-dev-tools python3-venv
python3 -m venv --system-site-packages ~/ros2-venv   # sees ROS's rclpy; conda/pyenv won't
source ~/ros2-venv/bin/activate
pip install "zeroruntime-teleops[ros2]"
sudo usermod -aG dialout $USER                       # serial access; log out and in
```

## Setup

On each machine:

```bash
cd ~/zrt-teleops-examples/ros2
cp .env.example .env      # token, room id, and this machine's arm(s)
source /opt/ros/jazzy/setup.bash
rosdep install --from-paths . --ignore-src -y
colcon build --symlink-install
```

In `.env`, give each arm its port as a `/dev/serial/by-id/...` path
(`ls /dev/serial/by-id/`; it survives a replug) and its calibration id (the
JSON must be under `~/.cache/huggingface/lerobot/calibration/`).

## Run

Two terminals per machine. The **launch terminal** starts the arm and joins
the room (`leader.launch.py` on the leader machine):

```bash
cd ~/zrt-teleops-examples/ros2
source /opt/ros/jazzy/setup.bash && source install/setup.bash
source ~/ros2-venv/bin/activate
set -a; source .env; set +a
ros2 launch so101_teleop_bringup follower.launch.py
```

Wait for the bridge's `topics: ...` line. The **command terminal** runs the
commands below:

```bash
cd ~/zrt-teleops-examples/ros2 && source env.sh
take_control              # on the leader machine; release_control to stop
```

- The follower moves straight to the leader's pose on `take_control` (a full
  sweep takes ~1.3 s). To refuse until the arms match, set `max_misalignment`
  in `bringup/config/bridge.yaml` (`0.05` = 5 % of travel).
- Ctrl-C in the follower's launch terminal turns torque off: hold the arm
  first. To leave with the arm holding, use `follower_leave`.

## Commands

| Command | Machine | What it does |
|---|---|---|
| `take_control` / `release_control` | leader | start / stop driving; the follower holds |
| `estop` / `follower_estop` | leader / follower | e-stop (stays latched) |
| `clear_estop` | follower | release the e-stop, then `take_control` again |
| `start_recording` / `stop_recording` | follower | start / stop recording |
| `start_episode ["task"]` | either | open an episode, optionally with a task |
| `end_episode [success\|fail]` | either | close it, optionally with an outcome |
| `follower_leave` / `follower_join` | follower | leave the room with the arm holding / rejoin |
| `leader_leave` / `leader_join` | leader | leave the room / rejoin |
| `follower_events`, `follower_stats` | follower | events / stats (same for `leader_`) |

Episode commands on the leader go through the room, so they work across
networks; they take effect only while the follower is recording.

## Recording and cameras

Recordings go to the cloud (billed): run `start_recording` on the follower
machine and wait for `cloud recording: ready`. Each `take_control` to
`release_control` is then an episode. If the cloud is not up within 90 s, it
records under `./sessions` only; a local copy is kept there anyway.
`cloud_recording: false` in `bridge.yaml` records locally only.

Cameras: the follower streams every USB camera. To choose, run
`python -m zeroruntime.teleops.devices` (venv active) and copy the
`ZERORUNTIME_CAMERAS=...` line it prints into `.env`, or set it to `none`.

## In the background

`env.sh` can run an arm and its bridge detached, instead of a launch
terminal (no colcon build needed; logs in `.run/`):

```bash
follower_up       # start; follower_logs to watch
follower_down     # leave the room, arm holding; follower_up rejoins
follower_off      # stop the arm: torque off, hold it first
```

## Policy mode

A policy can drive the follower by publishing `trajectory_msgs/JointTrajectory`
chunks (six joints, radians) to `/leader/zrt_teleop_bridge/action_chunk`.
On the leader machine: `policy_up` (the bridge, no arm), `take_control`, then
`fake_chunk 0.3` to send a test chunk.

## Docker (any 64-bit Linux)

The same setup in a container: Raspberry Pi OS, Debian, Ubuntu 22.04,
Jetson, ... (`dpkg --print-architecture` must print `arm64` or `amd64`).

```bash
curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER   # then log out and in
git clone https://github.com/ZeroRuntimeAI/zrt-teleops-examples.git ~/zrt-teleops-examples
cd ~/zrt-teleops-examples/ros2
cp .env.example .env      # fill in as in Setup
```

Copy the arm's calibration from where you ran `lerobot-calibrate` to the same
path here: `~/.cache/huggingface/lerobot/calibration/robots/so_follower/<id>.json`
(follower) or `.../teleoperators/so_leader/<id>.json` (leader). Then:

```bash
docker compose pull                 # or: docker compose build
docker compose up -d follower       # `leader` on the leader machine
docker compose logs -f follower     # wait for `topics: ...`
docker compose exec follower bash   # the command terminal: same commands
docker compose stop follower        # = Ctrl-C: torque off, hold the arm first
```

After editing `bringup/config/` or a reboot: `docker compose up -d <role>`
again. The background shortcuts (`follower_up`, `policy_up`, ...) are for the
native setup only.

## Troubleshooting

| Problem | Fix |
|---|---|
| `zrt-teleops-ros2-... not found` | `source ~/ros2-venv/bin/activate` |
| `usb_port ... does not exist` | unplugged, or use its `/dev/serial/by-id/...` path |
| `robot_id is required and empty` | the calibration id is missing in `.env` |
| Every servo `Read timeout` at start | the arm's power supply is off |
| `Read timeout` mid-session | support the arm and restart the follower; if it repeats, set `update_rate` (both `*_controllers.yaml`) and `control_hz` (`bridge.yaml`) to 100 and double `max_norm_step` |
| `take_control`: `no grant within 5.0s` | the follower is not in the room: check its launch terminal and that both `.env` have the same room id |
| The wrist turns half a turn on `take_control` | the wrists were calibrated differently: recalibrate both the same way |
| Joining fails with status 404 | the room id does not exist on this server: make one with the same token |
| `start_recording` says it runs on the follower | run it in the follower machine's command terminal |
| Installing Docker: `Not live until ...` | the clock is wrong: `sudo timedatectl set-ntp true` |
