# Caveats

What can bite on real arms: the symptom, why, and what to do. Items marked
*(to confirm on hardware)* follow from the driver and ros2_control source but
have not been checked on an arm yet.

**Stopping drops the follower.** Ctrl-c on `follower_up` stops only the
bridge: the arm stack keeps running and `forward_controller` holds the last
command, so the arm holds. `follower_down`, or killing the stack any other
way (including Ctrl-c on a plain `ros2 launch follower.launch.py`), shuts
down ros2_control, the driver deactivates and writes torque off to every
servo, and the arm falls. Support it first. The leader has no torque, so
nothing drops there. *(to confirm on hardware)*

**Middle pose reads ~3.14 rad.** Driver 0.2.2 reports `raw - offset` in
radians with `offset` defaulting to 0, and `lerobot-calibrate` homed the
servos so the middle pose reads ~2048 raw. The URDF sets `offset` 2048 on
every joint so that pose is 0 rad; keep it if you edit the URDF. Check
`ros2 topic echo /leader/joint_states --once` near the middle pose before the
first `arm`: with `max_misalignment` 0.0 (the default here) nothing refuses
to arm, so a wrong offset sends the follower to a wrong pose instead.
Verified on hardware: both arms read inside their calibrated ranges.

**`arm` moves the follower straight away.** `max_misalignment` 0.0 skips the
alignment check: the follower travels from wherever it is to the leader's
pose, at the slew limit (a full sweep in ~1.3 s). Keep the space around the
follower clear when you arm, or set `max_misalignment` > 0 to make `arm`
wait until the arms match.

**`joint_config_file` / `homing_offset` does nothing.** The apt driver
(0.2.2) reads only `usb_port` and per-joint `id` and `offset`. Newer source
builds accept a joint file, but it would re-write the same EEPROM values
lerobot already wrote. Not needed.

**The follower lags the leader.** `max_norm_step` in `bridge.yaml` caps each
joint's move per 5 ms tick, as a fraction of its full calibrated travel. The
default 0.00375 is 0.75 full travels per second at 200 Hz, the same glide as
the lerobot SO-101 path. The old 0.75 was effectively no limit. Raise it for
less lag, lower it for gentler lunges after a stall.

**The wrong servo moves.** The command is a bare array: position *i* goes to
`forward_controller`'s joint *i*, and the controller checks only the length.
Its `joints` must equal `joint_names` in `bridge.yaml`, in order;
`follower.launch.py` refuses to start otherwise.

**The follower stops taking commands after one bad message.** A command with
the wrong number of values (say, a hand-typed `ros2 topic pub` with 3) makes
ros2_control *deactivate* `forward_controller` ("Deactivating controllers …
as their update resulted in an error"), seen on Jazzy ros2_control 4.48. The
arm holds, but every later command is ignored, the bridge's included. Bring it
back with `ros2 control switch_controllers -c /follower/controller_manager
--activate forward_controller`. The bridge always sends all joints.

**The link drops and the follower keeps still.** `forward_command_controller`
has no timeout; it holds the last command forever. The SDK's watchdog
decides when to stop sending (HOLD). That is the intended failure.

**Gripper or wrist_roll cannot reach its full range.** Only if someone turned
on `enforce_command_limits`: the URDF's limits for those two are narrower
than the calibrated range. Leave it false (the default).

**Recordings are not where you expected.** `recording_dir` (`./sessions`)
is relative to the directory you ran `follower_up` from.

**The follower bridge fails at startup on `camera_handles`.** The values must
be strings: `['0', '2']` or `/dev/v4l/by-path/...` paths. An unquoted
`[0, 2]` is an integer array.

**`FeetechHardwareInterface::read` errors, `/follower/joint_states` under
200 Hz.** One serial bus carries all six servos at 200 Hz. If it cannot keep
up, lower `update_rate` in `*_controllers.yaml` and `control_hz` in
`bridge.yaml` together, e.g. to 100. *(to confirm on hardware)*

**The bridge warns nothing publishes, or arms against a dead arm.** The arm
stack must be up before the bridge arms. `follower_up` waits up to 30 s for
`forward_controller` to be active (`leader_up`: `joint_state_broadcaster`)
and prints the end of `.run/<role>_arm.log` if it is not.
