# Source this in bash, from anywhere:   source ros2/env.sh
# Loads ROS 2 Jazzy and .env, then defines the shortcuts below.

ZRT_ROS2="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source /opt/ros/jazzy/setup.bash

if [ -f "$ZRT_ROS2/.env" ]; then
    set -a; source "$ZRT_ROS2/.env"; set +a
else
    echo "no $ZRT_ROS2/.env -- cp .env.example .env, then fill it in"
fi

_bridge=/zrt_teleop_bridge
_config="$ZRT_ROS2/bringup/config"
_run="$ZRT_ROS2/.run"

# -- bring an arm up ---------------------------------------------------------
# <role>_up starts the arm stack (driver + controllers) in the background, in
# its own session, logging to .run/<role>_arm.log -- or reuses the one already
# running -- then runs the bridge in the foreground. Ctrl-C stops only the
# bridge: the follower holds its last command. <role>_down stops the stack.
# Anything after <role>_up goes to `ros2 launch`, e.g. usb_port:=/dev/ttyACM1.
follower_up() { _arm_up follower forward_controller hardware:=feetech \
                    usb_port:="$ZRT_FOLLOWER_PORT" "$@" && _bridge_fg follower "$ZRT_FOLLOWER_ID"; }
leader_up()   { _arm_up leader joint_state_broadcaster hardware:=feetech \
                    usb_port:="$ZRT_LEADER_PORT" "$@" && _bridge_fg leader "$ZRT_LEADER_ID"; }

# Stopping the follower stack turns its torque off: the arm drops.
follower_down() {
    if _arm_alive follower; then
        echo "follower_down turns the servos' torque off: the arm DROPS."
        read -r -p "Support the arm, then press Enter (Ctrl-C to cancel) " || return 1
    fi
    _arm_down follower
}
leader_down() { _arm_down leader; }   # no torque on the leader, nothing drops

# -- no arm ------------------------------------------------------------------
# The follower on mock_components: the commanded position becomes the state.
follower_mock() { _arm_up follower forward_controller hardware:=mock "$@" \
                      && _bridge_fg follower "$ZRT_FOLLOWER_ID"; }
# The leader is just the bridge; fake_leader stands in for the arm. No mock
# stack here: its joint_state_broadcaster would publish /leader/joint_states
# too and fight fake_leader. Anything after leader_mock goes to the bridge.
leader_mock() { _bridge_fg leader "$ZRT_LEADER_ID" "$@"; }
# fake_leader [radians]: all six joints at one value (default 0), 50 Hz.
fake_leader() { local v="${1:-0.0}"; ros2 topic pub -r 50 /leader/joint_states \
                    sensor_msgs/msg/JointState \
                    "{name: [shoulder_pan, shoulder_lift, elbow_flex, wrist_flex, wrist_roll, gripper],
                      position: [$v, $v, $v, $v, $v, $v]}"; }
watch_follower() { ros2 topic echo /follower/forward_controller/commands; }

# -- the leader machine --------------------------------------------------------
arm()    { ros2 service call /leader$_bridge/enable std_srvs/srv/SetBool "{data: true}"; }
disarm() { ros2 service call /leader$_bridge/enable std_srvs/srv/SetBool "{data: false}"; }
estop()  { ros2 service call /leader$_bridge/estop std_srvs/srv/Trigger; }

# -- the follower machine ------------------------------------------------------
follower_estop() { ros2 service call /follower$_bridge/estop std_srvs/srv/Trigger; }
clear_estop()    { ros2 service call /follower$_bridge/clear_estop std_srvs/srv/Trigger; }
record_on()   { ros2 service call /follower$_bridge/recording std_srvs/srv/SetBool "{data: true}"; }
record_off()  { ros2 service call /follower$_bridge/recording std_srvs/srv/SetBool "{data: false}"; }
episode_on()  { ros2 service call /follower$_bridge/episode std_srvs/srv/SetBool "{data: true}"; }
episode_off() { ros2 service call /follower$_bridge/episode std_srvs/srv/SetBool "{data: false}"; }

# -- plumbing ------------------------------------------------------------------
# The stack's pidfile holds its process group id (setsid makes it the leader).
_arm_pid()   { cat "$_run/$1_arm.pid" 2>/dev/null; }
# A launch that died leaves a zombie, and its group still answers kill -0.
_arm_alive() { local p; p="$(_arm_pid "$1")" && [ -n "$p" ] \
                   && kill -0 -- "-$p" 2>/dev/null \
                   && [ "$(ps -o state= -p "$p" 2>/dev/null)" != Z ]; }

# _arm_up ROLE CONTROLLER [launch args]: start ROLE's stack unless it is
# running, then wait up to 30 s for CONTROLLER to be active.
_arm_up() {
    local role="$1" ctl="$2"; shift 2
    local pidf="$_run/${role}_arm.pid" log="$_run/${role}_arm.log" end=$((SECONDS + 30))
    mkdir -p "$_run"
    if _arm_alive "$role"; then
        echo "$role arm already running (pid $(_arm_pid "$role")); reusing it as it is"
    else
        rm -f "$pidf"
        # A subshell so no job notices; setsid so Ctrl-C here never reaches it.
        ( setsid bash -c 'echo $$ >"$0"; exec "$@"' "$pidf" \
              ros2 launch "$ZRT_ROS2/bringup/launch/$role.launch.py" bridge:=false "$@" \
              >"$log" 2>&1 </dev/null & )
        echo "$role arm starting, log: $log"
    fi
    # timeout, or list_controllers waits forever when the stack never came up.
    until timeout 5 ros2 control list_controllers -c "/$role/controller_manager" 2>/dev/null \
            | grep -Eq "^$ctl( |\[).*[^n]active"; do
        if [ "$SECONDS" -ge "$end" ] || { [ -f "$pidf" ] && ! _arm_alive "$role"; }; then
            echo "$role arm: $ctl not active (stack exited, or 30 s passed). End of $log:"
            tail -n 20 "$log"
            _arm_alive "$role" && echo "it is still running: ${role}_down to stop it"
            return 1
        fi
        sleep 1
    done
}

# _arm_down ROLE: Ctrl-C the stack's process group, TERM it after 10 s.
_arm_down() {
    local role="$1" pid i
    if ! _arm_alive "$role"; then
        echo "$role arm not running"; rm -f "$_run/${role}_arm.pid"; return 0
    fi
    pid="$(_arm_pid "$role")"
    kill -INT -- "-$pid"
    for i in $(seq 10); do _arm_alive "$role" || break; sleep 1; done
    if _arm_alive "$role"; then kill -TERM -- "-$pid"; sleep 3; fi
    if _arm_alive "$role"; then
        echo "$role arm still running: kill -KILL -- -$pid"; return 1
    fi
    rm -f "$_run/${role}_arm.pid"
    echo "$role arm stopped"
}

# _bridge_fg ROLE ID [ros args]: the bridge node, in the foreground.
_bridge_fg() {
    local role="$1" id="$2"; shift 2
    local cmd=("zrt-teleops-ros2-$role" --ros-args
               --params-file "$_config/bridge.yaml" -r "__ns:=/$role")
    # Quoted so an all-digit id stays a string.
    [ -n "$id" ] && cmd+=(-p "robot_id:='$id'")
    "${cmd[@]}" "$@"
}
