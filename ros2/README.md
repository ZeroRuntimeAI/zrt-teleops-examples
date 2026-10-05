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
files and some shell shortcuts. One arm per machine, or both on one machine.
Read Troubleshooting below before the first run on real arms.

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
logging to `.run/<role>_arm.log`, waits for its controller, then starts the
bridge in the background too, logging to `.run/<role>_bridge.log`, and gives
the prompt back once it has joined the meeting. Both keep running when you
close the terminal or the ssh session. The leader arm is declared with no command
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

`arm` takes control straight away: the follower travels to the leader's
pose at the slew limit (`max_norm_step`, a full sweep in ~1.3 s), so no manual
lining up. To require the arms to match first, set `max_misalignment` in
`bridge.yaml` (0.05 = 5 % of travel); `arm` is then refused while any joint
differs by more, and the refusal names the joint.

Leaving and stopping, on either machine:

```bash
follower_logs   # follow the bridge's log; Ctrl-C stops only the tail
follower_down   # leave the meeting; the arm stack keeps running
follower_off    # leave, then stop the stack: torque OFF, the arm drops. Support it first.
```

`leader_logs`, `leader_down` and `leader_off` are the same on the leader
machine; the leader is limp anyway. After `follower_down` the follower holds
its last position, and `follower_up` rejoins, reusing the running stack.

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
episode_success  # or episode_fail: close it with an outcome stored alongside
record_off
```

For a cloud copy as well, set `cloud_recording: true` in the follower
machine's `bridge.yaml` and restart the follower bridge (`follower_down`,
then `follower_up`). `record_on` then records locally and in VideoSDK's
cloud; episodes wait until the cloud recorder is ready. `follower_logs`
shows each `cloud recording:` state.

## Without arms

The same session on mock hardware, to check the room, the token and the
wiring before a servo is involved. Two machines or two shells:

```bash
follower_mock                          # follower on mock_components (follower_off after)
leader_mock                            # the leader bridge alone (leader_down after)
fake_leader 0.2                        # stands in for the leader arm, radians
watch_follower                         # the commands the follower gets
arm
```

`watch_follower` prints six numbers per message once armed, and they
follow `fake_leader`. The bridge still needs a calibration to normalise
against, so `ZRT_LEADER_ID` / `ZRT_FOLLOWER_ID` must name a real JSON on
that machine.

## Watching

```bash
follower_events   # safe state, lease, limits, episodes... one JSON per line
leader_events     # lease granted / denied, active operator
follower_stats    # the SDK's stats, once a second (stats_hz)
leader_stats
```

The follower also publishes one `diagnostic_msgs/DiagnosticStatus` per
camera on `/diagnostics` (OK, WARN on missed reads, ERROR on a reopen), so
`rqt_robot_monitor` shows camera health.

## Topics and services

All under the bridge node, `/<role>/zrt_teleop_bridge/...`. Stock types
only, so nothing to build: anything structured is JSON in a
`std_msgs/String`, and arguments a `Trigger` cannot carry are parameters
(`ros2 param set` first).

| Role | Name | Type | What |
|---|---|---|---|
| both | `events` | pub `std_msgs/String` | SDK events as JSON |
| both | `stats` | pub `std_msgs/String` | stats JSON every `1/stats_hz` s |
| both | `active_operator` | pub `std_msgs/String`, latched | who may hold the lease; empty = first come |
| both | `estop` | srv `Trigger` | latch an e-stop |
| both | `set_active_operator` / `clear_active_operator` | srv `Trigger` | hand control to param `active_operator_id` / clear it |
| both | `rpc_call` | srv `Trigger` | call `rpc_method` on `rpc_peer` with `rpc_payload` (JSON); refused while armed |
| leader | `enable` | srv `SetBool` | arm / disarm |
| leader | `action_chunk` | sub `trajectory_msgs/JointTrajectory` | policy mode only, see below |
| leader | `observation_id` | pub `std_msgs/UInt64` | id of each follower observation |
| leader | `peer_id` | pub `std_msgs/String`, latched | this leader's id, for `active_operator_id` |
| leader | `remote/follower_states` | pub `sensor_msgs/JointState` | the follower's joints, leader units |
| follower | `safe_state` | pub `std_msgs/String`, latched | `holding`, `active`, `estopped`... |
| follower | `applied` | pub `std_msgs/String` | every write, if `publish_applied: true` |
| follower | `rpc/requests` | pub `std_msgs/String` | RPCs it answered (`rpc_methods`) |
| follower | `clear_estop` | srv `Trigger` | the only way out of an e-stop |
| follower | `recording` / `episode` | srv `SetBool` | start/stop |
| follower | `episode_end` | srv `SetBool` | close the episode, `data` = success |

## Policy mode (action chunks)

A policy can drive the follower instead of the leader arm. Start the leader
bridge with `leader_source: policy` and it stops reading
`/leader/joint_states`; the follower then moves only on chunks published to
`/leader/zrt_teleop_bridge/action_chunk`. Without arms:

```bash
follower_mock     # follower machine
policy_up         # leader machine: the bridge in policy mode (leader_down after)
arm
fake_chunk 0.3    # one chunk: shoulder_pan ramps 0 -> 0.3 rad over 200 ms
watch_follower
```

A chunk is a `trajectory_msgs/JointTrajectory`:

- `joint_names`: every joint in the bridge's `joint_names`, any order.
- `points[].positions`: in the leader's units, radians here, the same as
  `/leader/joint_states`.
- `points[].time_from_start`: evenly spaced (1 ms tolerance). Only the
  spacing counts; the follower starts playing on arrival and interpolates
  between points at its own control rate. A single point is held as a
  pose.
- `header.frame_id`: the last `observation_id` the policy saw, as a decimal
  string, or empty.

Each new chunk replaces the one still playing, so send overlapping
horizons. After the last point the arm holds. The follower still applies
its clamp, slew limit and watchdog every tick, and `disarm` / `estop` stop
it as usual. A chunk sent to a leader in the default `arm` mode is dropped
with a warning.

A minimal publisher:

```python
import rclpy
from builtin_interfaces.msg import Duration
from rclpy.node import Node
from std_msgs.msg import UInt64
from trajectory_msgs.msg import JointTrajectory, JointTrajectoryPoint

JOINTS = ["shoulder_pan", "shoulder_lift", "elbow_flex",
          "wrist_flex", "wrist_roll", "gripper"]
BRIDGE = "/leader/zrt_teleop_bridge"


class Policy(Node):
    def __init__(self):
        super().__init__("policy")
        self.oid = None
        self.create_subscription(UInt64, f"{BRIDGE}/observation_id",
                                 lambda m: setattr(self, "oid", m.data), 10)
        self.pub = self.create_publisher(JointTrajectory,
                                         f"{BRIDGE}/action_chunk", 10)
        self.create_timer(0.2, self.step)        # a new horizon every 200 ms

    def step(self):
        actions = [[0.0] * len(JOINTS) for _ in range(10)]   # your model here
        msg = JointTrajectory(joint_names=JOINTS)
        msg.header.frame_id = "" if self.oid is None else str(self.oid)
        for i, a in enumerate(actions):
            msg.points.append(JointTrajectoryPoint(
                positions=a,
                time_from_start=Duration(nanosec=(i + 1) * 20_000_000)))
        self.pub.publish(msg)


rclpy.init()
rclpy.spin(Policy())
```

The follower's state, for the policy's input, is on
`/leader/zrt_teleop_bridge/remote/follower_states`.

## Troubleshooting

**The bridge warns that nothing publishes a topic.** The controllers are
not up, or a name is off. `ros2 control list_controllers -c
/follower/controller_manager` should show `joint_state_broadcaster` (and
`forward_controller`) active; `ros2 topic list` should include
`/leader/joint_states`, `/follower/joint_states` and
`/follower/forward_controller/commands`. The stack's own output is in
`.run/<role>_arm.log`, the bridge's in `.run/<role>_bridge.log`.

**`arm` is refused as misaligned.** Only with `max_misalignment` > 0: read
the message, move the leader. To see
where the follower is from the leader machine: `ros2 topic echo
/leader/zrt_teleop_bridge/remote/follower_states`.

**The follower does not move, and `forward_controller` logs a size
error.** A command of the wrong length deactivates the controller, and it
stays off: `ros2 control switch_controllers -c /follower/controller_manager
--activate forward_controller`. Its `joints` in `follower_controllers.yaml`
and `joint_names` in `bridge.yaml` must be the same list in the same order;
the launch file refuses to start otherwise.

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
bringup/launch/              leader.launch.py, follower.launch.py
bringup/urdf/                so101.urdf.xacro + TheRobotStudio's URDFs (Apache-2.0, see NOTICE)
bringup/config/              controllers, bridge params
```
