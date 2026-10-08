# ros2

Two SO-101 arms on ROS 2 (ros2_control): you move the leader by hand and the
follower copies it over the internet. One machine per arm.

## Needs

- Ubuntu 24.04 with ROS 2 Jazzy, two SO-101 arms calibrated with
  `lerobot-calibrate`, and a token and room id (the same on both machines).
- Not on Ubuntu 24.04? Use [Docker](#docker-any-64-bit-linux).

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

- On `take_control` the follower moves straight to the leader's pose, so
  line the arms up first.
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

Recordings are saved to the cloud. Start one with `start_recording` on the
follower machine; each time you take and release control is one episode. If
the cloud is not available, the recording is saved on the follower machine
instead.

Cameras: the follower streams every USB camera. To choose, run
`python -m zeroruntime.teleops.devices` (venv active) and copy the
`ZERORUNTIME_CAMERAS=...` line it prints into `.env`, or set it to `none`.


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
again.

## Troubleshooting

| Problem | Fix |
|---|---|
| `zrt-teleops-ros2-... not found` | `source ~/ros2-venv/bin/activate` |
| `usb_port ... does not exist` | unplugged, or use its `/dev/serial/by-id/...` path |
| `robot_id is required and empty` | the calibration id is missing in `.env` |
| Every servo `Read timeout` at start | the arm's power supply is off |
| `take_control`: `no grant within 5.0s` | the follower is not in the room: check its launch terminal and that both `.env` have the same room id |
| The wrist turns half a turn on `take_control` | the wrists were calibrated differently: recalibrate both the same way |
| Joining fails with status 404 | the room id does not exist on this server: make one with the same token |
| A command says it runs on the leader / follower machine | run it in that machine's command terminal (the table above says which) |
