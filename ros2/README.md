# ros2

Two SO-101 arms: you move the leader by hand and the follower copies it over
the internet. Each arm runs on ROS 2 with ros2_control. The arms can be on
two machines, or both on one. Not on Ubuntu 24.04? See
[Docker](#docker-any-64-bit-linux).

## Needs

- Ubuntu 24.04 and ROS 2 Jazzy, on each machine
- Two SO-101 arms, calibrated with `lerobot-calibrate`
- A token and a room id, the same on both machines

```bash
sudo apt install ros-jazzy-ros2-control ros-jazzy-ros2-controllers \
    ros-jazzy-controller-manager ros-jazzy-feetech-ros2-driver \
    ros-jazzy-xacro ros-jazzy-robot-state-publisher ros-dev-tools
```

The SDK goes into a venv that can see ROS's own Python packages:

```bash
python3 -m venv --system-site-packages ~/ros2-venv
source ~/ros2-venv/bin/activate
pip install "zeroruntime-teleops[ros2]"
```

`which zrt-teleops-ros2-leader` should now print a path. A conda or pyenv
Python will not work: it cannot import ROS's `rclpy`.

Serial access: `sudo usermod -aG dialout $USER`, then log out and in.

## Setup

On each machine:

```bash
cd ~/zrt-teleops-examples/ros2
cp .env.example .env
```

Then open `.env` and fill in the token and room id, and for each arm on
this machine:

- its port, as a `/dev/serial/by-id/...` path (`ls /dev/serial/by-id/`).
  Unlike `/dev/ttyACM0`, it does not change after a replug.
- its calibration id: the name you gave `lerobot-calibrate`. The JSON must
  be under `~/.cache/huggingface/lerobot/calibration/` on this machine.

Build once:

```bash
source /opt/ros/jazzy/setup.bash
rosdep install --from-paths . --ignore-src -y   # new to rosdep? sudo rosdep init && rosdep update
colcon build --symlink-install
```

## Run

Two terminals on each machine: the launch terminal starts the arm and joins
the room, the command terminal runs the shortcuts. In the launch terminal
(`leader.launch.py` on the leader machine):

```bash
cd ~/zrt-teleops-examples/ros2
source /opt/ros/jazzy/setup.bash
source install/setup.bash
source ~/ros2-venv/bin/activate
set -a; source .env; set +a
ros2 launch so101_teleop_bringup follower.launch.py
```

The follower arm goes stiff and holds where it is; the leader arm stays
limp. Wait until the launch terminal prints the bridge's `topics: ...` line
on both machines, then in the command terminal:

```bash
cd ~/zrt-teleops-examples/ros2
source env.sh
```

Run `take_control` on the leader machine. The follower copies the leader
until you run `release_control`. Both arms on one machine: fill in both in
`.env` and run each launch file in its own launch terminal.

Before the first run on real arms:

- Nothing moves until `take_control`. Then the follower moves straight to
  the leader's pose: a full sweep takes ~1.3 s (`max_norm_step` in
  `bringup/config/bridge.yaml`). To make `take_control` wait until the arms
  match, set `max_misalignment` there (`0.05` = 5 % of travel).
- After an e-stop, `clear_estop` on the follower machine, then
  `take_control` again. It is refused while the follower is e-stopped.
- Ctrl-C in the follower's launch terminal stops the driver: torque goes off
  and only the gears hold the arm, so a loaded pose can sag or drop. Hold it
  first.
- To leave with the arm actively holding: `release_control` on the leader, then
  `follower_leave`. The arm holds; `follower_join` rejoins. An e-stop stays
  latched, and a recording is closed and not resumed.
- Ctrl-C on the leader is harmless: the leader arm is limp anyway.

## Commands

In the command terminal, after `source env.sh`:

| Command | Machine | What it does |
|---|---|---|
| `take_control` | leader | start driving the follower |
| `release_control` | leader | stop driving; the follower holds where it is |
| `estop` | leader | e-stop the follower (stays latched) |
| `follower_estop` | follower | e-stop from the follower side (stays latched) |
| `clear_estop` | follower | release the e-stop; only the follower side can |
| `start_recording` / `stop_recording` | follower | start / stop recording |
| `start_episode` / `end_episode` | either | open / close an episode by hand (see below) |
| `start_episode "task"` | either | open an episode with this task, e.g. `start_episode "pick up the orange cube"`; later `start_episode` calls on that machine keep it until you give another |
| `end_episode success` / `end_episode fail` | either | close the episode marked as a success or a failure; the data is kept either way |
| `follower_leave` / `follower_join` | follower | leave the room with the arm holding / rejoin |
| `leader_leave` / `leader_join` | leader | leave the room, releasing control / rejoin |
| `follower_events` / `leader_events` | follower / leader | print events as they happen, one JSON per line |
| `follower_stats` / `leader_stats` | follower / leader | print stats once a second |
| `watch_follower` | follower | print the commands the follower's controller gets |

Each is one `ros2` command; `env.sh` shows which. Full reference: the ROS 2
docs.

The episode commands use the follower's bridge when it runs on this machine's
ROS graph, else the leader's, which asks the follower through the room, so it
works across networks. Either way an episode opens or closes only while the
follower is recording; on the leader the reply only confirms the request was
sent, so watch `follower_events` on the follower to see it happen.
`start_recording` / `stop_recording` stay on the follower.

## Recording and cameras

Both happen on the follower machine, set in `bringup/config/bridge.yaml`.
`start_recording` writes under `./sessions` (`recording_dir`) and replies
with the full path. While recording, each `take_control` to
`release_control` is an episode on its own.

Cameras: every USB camera on the follower is streamed, as `cam0`, `cam1`, ...
To choose, set `ZERORUNTIME_CAMERAS` in `.env` to their names, comma-separated,
or `none`. To list the names, on the follower machine with the venv active:

```bash
python -m zeroruntime.teleops.devices
```

It ends with a ready `ZERORUNTIME_CAMERAS=...` line: copy it into `.env` and
drop any camera you don't want. Each name follows the USB port the camera is
plugged into.

Cloud copy: on by default (`cloud_recording: true`; VideoSDK bills it).
Until the cloud recorder is ready, episodes are refused; the log shows each
`cloud recording:` state. If it is not ready within 90 s
(`cloud_recording_timeout_s`), recording carries on locally only. For local
only, set `cloud_recording: false` and restart the follower (hold the arm and
restart the launch, or `follower_down` then `follower_up`).

## In the background

Instead of a launch terminal, `env.sh` can run an arm and its bridge
detached, so they survive a closed terminal or ssh session. Activate the
venv, `source env.sh`, then (`leader_*` on the leader machine; nothing drops
there):

```bash
follower_up     # the arm, then the bridge
follower_logs   # follow the bridge's log; Ctrl-C stops only the tail
follower_down   # leave the room; the arm keeps holding. follower_up rejoins
follower_off    # leave and stop the arm: torque off, it can sag. Hold it first
```

No colcon build needed; logs go to `.run/`. `follower_up` / `leader_up`
refuse while a `ros2 launch` of that arm is already running.

## Policy mode

A policy can drive the follower instead of the leader arm, by publishing
`trajectory_msgs/JointTrajectory` chunks (all six joints, in radians) to
`/leader/zrt_teleop_bridge/action_chunk`. With the follower running:

```bash
policy_up        # leader machine, instead of the launch terminal: the bridge, no arm (leader_down to stop)
take_control
fake_chunk 0.3   # one test chunk: shoulder_pan ramps to 0.3 rad over 200 ms
watch_follower   # follower machine: the commands it gets
```

`ZERORUNTIME_LEADER_ID` must still name a leader calibration on that machine. The
follower's joints are on `/leader/zrt_teleop_bridge/remote/follower_states`.

## Docker (any 64-bit Linux)

Runs the same thing in a container, so the machine needs no ROS and no
Ubuntu 24.04: Raspberry Pi OS, Debian, Ubuntu 22.04, Jetson, ... Any
64-bit Linux works (`dpkg --print-architecture` prints `arm64` or `amd64`).

**1. Install Docker** (skip if `docker compose version` works):

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER      # then log out and back in
```

**2. Get the example and fill in `.env`:**

```bash
cd ~
git clone https://github.com/ZeroRuntimeAI/zrt-teleops-examples.git
cd ~/zrt-teleops-examples/ros2
cp .env.example .env
nano .env
```

Fill in the token, the room id, and this machine's arm: its port
(`ls /dev/serial/by-id/`) and its calibration id. Same as [Setup](#setup).

**3. Copy the arm's calibration here.** Calibrate with `lerobot-calibrate`
on any machine, then put the file in the same place on this one:

```
~/.cache/huggingface/lerobot/calibration/robots/so_follower/<id>.json        # follower
~/.cache/huggingface/lerobot/calibration/teleoperators/so_leader/<id>.json   # leader
```

**4. Start it**, on each machine with the role of its arm. Both arms on
one machine: run both.

```bash
cd ~/zrt-teleops-examples/ros2
docker compose pull                # first time, and to update

docker compose up -d follower      # on the follower machine
docker compose logs -f follower    # wait for `topics: ...`, then Ctrl-C (stops only the log)

docker compose up -d leader        # on the leader machine
docker compose logs -f leader
```

**5. Commands**, in a second terminal on the same machine:

```bash
cd ~/zrt-teleops-examples/ros2
docker compose exec follower bash  # on the follower machine: clear_estop, start_recording, ...
docker compose exec leader bash    # on the leader machine: take_control, release_control, ...
```

The [commands](#commands) are the same as in the native setup; the table
says which machine each one runs on.

**Stop:** `docker compose stop follower` or `docker compose stop leader`.
This is Ctrl-C: on the follower, torque goes off and the arm can sag, so
hold it first; the leader is limp anyway. After a reboot, run step 4 again.

Good to know:

- After editing `bringup/config/` (e.g. `bridge.yaml`):
  `docker compose restart follower` or `restart leader` (hold the follower).
- Camera names for `ZERORUNTIME_CAMERAS`:
  `docker compose run --rm follower python -m zeroruntime.teleops.devices`.
- Recordings land in `~/zrt-teleops-examples/ros2/sessions/`.
- `follower_up`, `policy_up` and the other [background](#in-the-background)
  shortcuts are for the native setup; in Docker, use `docker compose`.
- If `docker compose pull` fails, build the image here instead (~10 min):
  `docker compose build`.

## Troubleshooting

| Problem | Fix |
|---|---|
| `zrt-teleops-ros2-... not found` | activate the venv: `source ~/ros2-venv/bin/activate` |
| `usb_port ... does not exist` | the arm is unplugged, or the port moved: use its `/dev/serial/by-id/...` path |
| `parameter 'robot_id' is required and empty` | the calibration id is empty in `.env` |
| Every servo `Read timeout` at start | the servo power supply is not connected (USB alone still shows the port) |
| `Read timeout` mid-session, the follower goes limp | the driver gave up on the arm. Support it and restart the follower (restart the launch, or `follower_off` then `follower_up`). If it happens again, set `update_rate` in both `*_controllers.yaml` and `control_hz` in `bridge.yaml` to 100, and double `max_norm_step` to keep the speed |
| `take_control` says `no grant within 5.0s` | the follower is not in the room: check its launch terminal, and that both `.env` files have the same room id |
| The bridge warns `nothing publishes ...` | the arm is not up: check the launch terminal, and `ros2 control list_controllers -c /follower/controller_manager` |
| The wrist turns half a turn on `take_control` | the two wrists were calibrated in different orientations: recalibrate both the same way |
| Joints read ~3.14 rad off | `offset` 2048 is missing from `bringup/urdf/so101.urdf.xacro`: put it back |
| The follower ignores all commands after a hand-typed `ros2 topic pub` | a wrong-length command switched `forward_controller` off: `ros2 control switch_controllers -c /follower/controller_manager --activate forward_controller` |
| Joining fails with `Server config request failed with status 404` | the room id does not exist on this server, e.g. it was made on another VideoSDK environment: make a room with the same token |
| Joining fails with `Missing transport id` | the server accepted the room but could not set up media: try a new room id; if it persists, it is on the server side |
| Installing Docker fails with `Not live until ...` | the clock is wrong (common on a Pi): `sudo timedatectl set-ntp true`, check `date -u`, retry |
