# ros2

The `so101/` setup, with ROS 2 in the middle. Each arm is an ordinary
ros2_control robot — `feetech_ros2_driver` on the servos, stock controllers
on top — and the bridge is one more node beside it that moves joint states
through the room.

```
leader host                                    follower host
───────────                                    ─────────────
SO-101 (limp)                                  SO-101
   │ feetech_ros2_driver                          ▲ feetech_ros2_driver
   ▼                                              │
joint_state_broadcaster                        forward_controller
   │ /leader/joint_states                         │ /follower/forward_controller/commands
   ▼                                              │
zrt-teleops-ros2-leader  ◀── video + state ──  zrt-teleops-ros2-follower
                         ─── actions ───────▶     ▲ /follower/joint_states
```

There are no nodes of our own here: a URDF, controller configs, two launch
files and some shell shortcuts. One arm per machine. Read
[`caveats.md`](caveats.md) before the first run on real arms.

## Needs

- Ubuntu 24.04 and ROS 2 Jazzy, on each machine
- Two SO-101 arms, calibrated with `lerobot-calibrate`
- A room id and a token, the same on both machines

The ROS packages, all from the ROS apt repository:

```bash
sudo apt install ros-jazzy-ros2-control ros-jazzy-ros2-controllers \
    ros-jazzy-controller-manager ros-jazzy-feetech-ros2-driver \
    ros-jazzy-xacro ros-jazzy-robot-state-publisher
```

The SDK goes into the **same Python ROS uses** (`/usr/bin/python3`, 3.12),
because the bridge imports `rclpy`, which comes from apt, not pip. Ubuntu
24.04 refuses a plain `pip install` there, so either use a venv that can see
the system packages:

```bash
python3 -m venv --system-site-packages ~/zrt-venv
source ~/zrt-venv/bin/activate
pip install "zeroruntime-teleops[ros2]"
```

(activate it in every shell you launch from), or install for your user:

```bash
pip install --user --break-system-packages "zeroruntime-teleops[ros2]"
```

Either way, `which zrt-teleops-ros2-leader` should print a path. A
conda or pyenv Python will not work: it cannot import the apt `rclpy`.

Serial access: `sudo usermod -aG dialout $USER`, then log out and in.

## Setup

On each machine:

```bash
cd ros2
cp .env.example .env
```

Then open `.env` and fill it in — the token, the room id, and the port and
calibration id of the arm that machine has. The room id and token are the
SDK's own variable names, `ZERORUNTIME_AUTH_TOKEN` and
`ZERORUNTIME_MEETING_ID`, because the node reads them itself.

The calibration id is the name you gave `lerobot-calibrate`; lerobot wrote
`<id>.json` under `~/.cache/huggingface/lerobot/calibration/`. If you
calibrated on another machine, copy that file to the same place here.

Nothing to generate. `lerobot-calibrate` already wrote each servo's homing
offset and limits into the servo itself, so the middle pose reads about
2048; the URDF gives every joint `offset` 2048, which makes that pose 0 rad
in ROS. The bridge still reads the JSON (`calibration_profile` and
`robot_id`) to scale each joint against its calibrated range.

## Run

Every new shell: `source ros2/env.sh` (and your venv, if you used one).

On the follower machine:

```bash
follower_up
```

On the leader machine:

```bash
leader_up
```

Each starts the arm stack — driver and controllers — in the background,
logging to `.run/<role>_arm.log`, waits for its controller, then runs the
bridge in the foreground. The leader arm is declared with no command
interface, so the driver never enables its torque and it stays limp in your
hand. The follower is stiff as soon as the driver loads, holding where it
was.

Then, on the leader machine:

```bash
arm        # claim the follower and start sending
disarm     # stop sending; the follower holds where it is
estop      # latch an e-stop on the follower
```

On the follower machine:

```bash
follower_estop   # latch an e-stop from this side
clear_estop      # only here, on purpose: whoever can see the arm clears it
```

`arm` is refused while the arms disagree by more than `max_misalignment` in
`bridge.yaml`; the refusal names the worst joint. Move the leader toward the
follower's pose and `arm` again.

Ctrl-c stops only the bridge; the arm stack keeps running, and the follower
holds its last position. `follower_up` again reuses it. To stop the stack:

```bash
follower_down   # torque OFF: the arm drops. Support it first.
leader_down     # the leader is limp anyway
```

Anything after `follower_up` / `leader_up` goes to `ros2 launch`, e.g.
`follower_up usb_port:=/dev/ttyACM1`.

## Recording and cameras

Cameras belong to the follower and go through the SDK, not ROS: uncomment
`camera_handles` and `camera_labels` in `bringup/config/bridge.yaml`. The
leader side sees them as video.

Recording is on the follower machine too:

```bash
record_on      # start writing to recording_dir (bridge.yaml)
episode_on     # start an episode, tagged with episode_task
episode_off
record_off
```

## Without arms

The same session on mock hardware, to check the room, the token and the
wiring before a servo is involved. Two machines or two shells:

```bash
follower_mock                          # follower on mock_components (follower_down after)
leader_mock                            # the leader bridge alone
fake_leader 0.2                        # stands in for the leader arm, radians
watch_follower                         # the commands the follower gets
arm
```

`watch_follower` prints six numbers per message once armed, and they
follow `fake_leader`. The bridge still needs a calibration to normalise
against, so `ZRT_LEADER_ID` / `ZRT_FOLLOWER_ID` must name a real JSON on
that machine. If `arm` is refused as misaligned, the mock follower sits at
0 rad: try another `fake_leader` value, or `leader_mock -p
max_misalignment:=0.0` for this test only.

## Troubleshooting

**The bridge warns that nothing publishes a topic.** The controllers are
not up, or a name is off. `ros2 control list_controllers -c
/follower/controller_manager` should show `joint_state_broadcaster` (and
`forward_controller`) active; `ros2 topic list` should include
`/leader/joint_states`, `/follower/joint_states` and
`/follower/forward_controller/commands`. The stack's own output is in
`.run/<role>_arm.log`.

**`arm` is refused.** Misaligned: read the message, move the leader. To see
where the follower is from the leader machine: `ros2 topic echo
/leader/zrt_teleop_bridge/remote/follower_states`.

**The follower does not move, and `forward_controller` logs a size
error.** Its `joints` in `follower_controllers.yaml` and `joint_names` in
`bridge.yaml` must be the same list in the same order; the launch file
refuses to start otherwise.

**Read errors from the driver, or `ros2 topic hz /follower/joint_states`
well under 200.** The servo bus is not keeping up. Lower `update_rate` in
both `*_controllers.yaml` and `control_hz` in `bridge.yaml` together, e.g.
to 100.

**`usb_port ... does not exist`.** Unplugged, or the number moved. The
`/dev/serial/by-id/...` path does not move.

**RViz shows no arm.** The URDFs reference their STL meshes by relative
path (`assets/*.stl`), and the meshes are not copied here. Nothing in this
setup loads them — robot_state_publisher only needs the joints and links —
but RViz does, and wants `package://` or `file://` URIs. Not set up here.

## Files

```
env.sh                       shortcuts; source it
caveats.md                   what can bite, and what to do
bringup/launch/              leader.launch.py, follower.launch.py
bringup/urdf/                so101.urdf.xacro + TheRobotStudio's URDFs (Apache-2.0, see NOTICE)
bringup/config/              controllers, bridge params
```
