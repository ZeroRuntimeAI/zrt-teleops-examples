# Source this in bash, from anywhere:   source ros2/env.sh
# Loads ROS 2 Jazzy and .env, then defines the shortcuts below.

ZERORUNTIME_ROS2="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source /opt/ros/jazzy/setup.bash

if [ -f "$ZERORUNTIME_ROS2/.env" ]; then
    set -a; source "$ZERORUNTIME_ROS2/.env"; set +a
else
    echo "no $ZERORUNTIME_ROS2/.env -- cp .env.example .env, then fill it in"
fi

_bridge=/zrt_teleop_bridge
_config="$ZERORUNTIME_ROS2/bringup/config"
_run="$ZERORUNTIME_ROS2/.run"

# -- join and leave ----------------------------------------------------------
# <role>_up starts (or reuses) the arm stack, then the bridge, in the
# background with logs in .run/, and returns once joined. Closing the terminal
# stops neither. Extra args go to `ros2 launch`, e.g. usb_port:=/dev/ttyACM1.
follower_up() { _have_bridge follower && _arm_up follower forward_controller hardware:=feetech \
                    usb_port:="$ZERORUNTIME_FOLLOWER_PORT" "$@" && _bridge_up follower "$ZERORUNTIME_FOLLOWER_ID"; }
leader_up()   { _have_bridge leader && _arm_up leader joint_state_broadcaster hardware:=feetech \
                    usb_port:="$ZERORUNTIME_LEADER_PORT" "$@" && _bridge_up leader "$ZERORUNTIME_LEADER_ID"; }

# <role>_down leaves the meeting; the arm stack keeps running, so the follower holds.
follower_down() { _stop follower_bridge 15 && echo "left the meeting; the follower arm keeps" \
                      "holding (forward_controller keeps the last command); follower_off to power it down"; }
leader_down()   { _stop leader_bridge 15 && echo "left the meeting"; }

# <role>_off leaves and stops the stack. On the follower torque goes off: the arm can sag.
follower_off() {
    if _alive follower_arm; then
        echo "follower_off turns the servos' torque off: only the gears hold the arm, it can sag or drop."
        read -r -p "Support the arm, then press Enter (Ctrl-C to cancel) " || return 1
    fi
    _off follower
}
leader_off() { _off leader; }   # no torque on the leader, nothing drops

# Ctrl-C stops only the tail, not the bridge.
follower_logs() { tail -n 50 -F "$_run/follower_bridge.log"; }
leader_logs()   { tail -n 50 -F "$_run/leader_bridge.log"; }

# -- no arm ------------------------------------------------------------------
# follower_up on mock hardware: the commanded position becomes the state.
follower_mock() { _arm_up follower forward_controller hardware:=mock "$@" \
                      && _bridge_up follower "$ZERORUNTIME_FOLLOWER_ID"; }
# The bridge alone, fed by fake_leader. No mock stack: its broadcaster would
# fight fake_leader on /leader/joint_states.
leader_mock() { _bridge_up leader "$ZERORUNTIME_LEADER_ID" "$@"; }
# fake_leader [radians]: all six joints at one value (default 0), 50 Hz.
fake_leader() { local v="${1:-0.0}"; ros2 topic pub -r 50 /leader/joint_states \
                    sensor_msgs/msg/JointState \
                    "{name: [shoulder_pan, shoulder_lift, elbow_flex, wrist_flex, wrist_roll, gripper],
                      position: [$v, $v, $v, $v, $v, $v]}"; }
watch_follower() { ros2 topic echo /follower/forward_controller/commands; }

# -- policy instead of an arm --------------------------------------------------
# The leader bridge driven by ~/action_chunk instead of an arm. No alignment
# gate: a policy has no arm to align.
policy_up() { _bridge_up leader "$ZERORUNTIME_LEADER_ID" -p leader_source:=policy \
                  -p max_misalignment:=0.0 "$@"; }
# fake_chunk [radians]: one 10-point chunk ramping shoulder_pan to radians
# (default 0.3). Needs policy_up, then take_control.
fake_chunk() {
    local rad="${1:-0.3}" pts="" i v
    for i in $(seq 0 9); do
        v="$(awk -v r="$rad" -v i="$i" 'BEGIN { printf "%.6f", r * i / 9 }')"
        pts+="{positions: [$v, 0.0, 0.0, 0.0, 0.0, 0.0], time_from_start: {sec: 0, nanosec: $(( (i + 1) * 20000000 ))}},"
    done
    ros2 topic pub --once -w 1 /leader$_bridge/action_chunk trajectory_msgs/msg/JointTrajectory \
        "{joint_names: [shoulder_pan, shoulder_lift, elbow_flex, wrist_flex, wrist_roll, gripper],
          points: [${pts%,}]}"
}

# One-sided commands run only where that role's bridge runs: on a shared LAN
# the other machine's would answer, or a call would wait forever.
_here() { pgrep -f "bin/zrt-teleops-ros2-$1" >/dev/null || {
    echo "$2 runs on the $1 machine: run it there (in its command terminal)"
    return 1; }; }

# -- the leader machine --------------------------------------------------------
take_control()    { _here leader take_control && ros2 service call /leader$_bridge/take_control std_srvs/srv/Trigger; }
release_control() { _here leader release_control && ros2 service call /leader$_bridge/release_control std_srvs/srv/Trigger; }
# Leave / rejoin the meeting; the bridge and the arm stack keep running.
leader_leave() { _here leader leader_leave && ros2 service call /leader$_bridge/leave std_srvs/srv/Trigger; }
leader_join()  { _here leader leader_join && ros2 service call /leader$_bridge/join std_srvs/srv/Trigger; }

# -- the follower machine ------------------------------------------------------
follower_estop() { estop; }   # older name for estop
start_recording() { _here follower start_recording && ros2 service call /follower$_bridge/start_recording std_srvs/srv/Trigger; }
stop_recording()  { _here follower stop_recording && ros2 service call /follower$_bridge/stop_recording std_srvs/srv/Trigger; }
# Leave / rejoin the meeting; the arm stack keeps running, so the arm holds.
follower_leave() { _here follower follower_leave && ros2 service call /follower$_bridge/leave std_srvs/srv/Trigger; }
follower_join()  { _here follower follower_join && ros2 service call /follower$_bridge/join std_srvs/srv/Trigger; }

# -- either machine ----------------------------------------------------------
# This machine's bridge: the follower's if it runs here, else the leader's,
# which reaches the follower through the room (works across networks).
_this_bridge() {
    if pgrep -f bin/zrt-teleops-ros2-follower >/dev/null; then echo "/follower$_bridge"; else echo "/leader$_bridge"; fi
}
# E-stop the follower; it stays latched until clear_estop on the follower.
estop() { ros2 service call "$(_this_bridge)/estop" std_srvs/srv/Trigger; }
# Release the e-stop; it goes to the follower's bridge.
clear_estop() { ros2 service call /follower$_bridge/clear_estop std_srvs/srv/Trigger; }
# Episodes open or close only while the follower is recording.
# start_episode ["task"]: open an episode; the task stays for the next ones.
start_episode() {
    local node; node="$(_this_bridge)"
    if [ -n "$*" ]; then
        local q="'"   # YAML-quoted, so a task like "123" or "a: b" stays text
        ros2 param set "$node" episode_task "'${*//$q/$q$q}'" \
            | grep -q '^Set parameter successful' || return 1
    fi
    ros2 service call "$node/start_episode" std_srvs/srv/Trigger
}
# end_episode [success|fail]: close the open episode, with an outcome if given.
end_episode() {
    local node; node="$(_this_bridge)"
    case "$1" in
        "")      ros2 service call "$node/end_episode" std_srvs/srv/Trigger ;;
        success) ros2 service call "$node/end_episode_success" std_srvs/srv/Trigger ;;
        fail)    ros2 service call "$node/end_episode_fail" std_srvs/srv/Trigger ;;
        *)       echo "usage: end_episode [success|fail]"; return 1 ;;
    esac
}

# -- watching, either machine --------------------------------------------------
# One JSON object per message: events as they happen, stats once a second.
follower_events() { ros2 topic echo --field data /follower$_bridge/events std_msgs/msg/String; }
leader_events()   { ros2 topic echo --field data /leader$_bridge/events std_msgs/msg/String; }
follower_stats()  { ros2 topic echo --field data /follower$_bridge/stats std_msgs/msg/String; }
leader_stats()    { ros2 topic echo --field data /leader$_bridge/stats std_msgs/msg/String; }

# -- plumbing ------------------------------------------------------------------
# NAME is <role>_arm or <role>_bridge; .run/NAME.pid holds its process group id.
_pid()   { cat "$_run/$1.pid" 2>/dev/null; }
# A process that died leaves a zombie, and its group still answers kill -0.
_alive() { local p; p="$(_pid "$1")" && [ -n "$p" ] \
               && kill -0 -- "-$p" 2>/dev/null \
               && [ "$(ps -o state= -p "$p" 2>/dev/null)" != Z ]; }
# _running ROLE NODE: /ROLE/NODE is up, whoever started it.
_running() { ros2 node list 2>/dev/null | grep -qx "/$1/$2"; }
_have_bridge() { command -v "zrt-teleops-ros2-$1" >/dev/null || {
    echo "zrt-teleops-ros2-$1 not found: activate the SDK's venv first (e.g. source ~/ros2-venv/bin/activate)"
    return 1; }; }

# _spawn NAME CMD...: CMD in its own session, out of reach of Ctrl-C here and
# a closed terminal. setsid -f, not `&`: a script's background job ignores
# SIGINT, and SIGINT is how both stop cleanly. The pidfile appears just after.
_spawn() {
    local name="$1"; shift
    mkdir -p "$_run"; rm -f "$_run/$name.pid"
    setsid -f bash -c 'echo $$ >"$0"; exec "$@"' "$_run/$name.pid" "$@" \
        >"$_run/$name.log" 2>&1 </dev/null
}

# _arm_up ROLE CONTROLLER [launch args]: start ROLE's stack unless it is
# running, then wait up to 30 s for CONTROLLER to be active.
_arm_up() {
    local role="$1" ctl="$2"; shift 2
    local pidf="$_run/${role}_arm.pid" log="$_run/${role}_arm.log" end=$((SECONDS + 30))
    if _alive "${role}_arm"; then
        echo "$role arm already running (pid $(_pid "${role}_arm")); reusing it as it is"
    elif _running "$role" controller_manager; then
        # Started by `ros2 launch` elsewhere: a second stack would fight it for the port.
        echo "$role arm already running outside env.sh (ros2 launch?): not starting a second one." \
             "Use this terminal for commands: $([ "$role" = leader ] && echo take_control, start_episode || echo start_recording, stop_recording), ${role}_leave, ${role}_join ..."
        return 1
    else
        _spawn "${role}_arm" ros2 launch "$ZERORUNTIME_ROS2/bringup/launch/$role.launch.py" bridge:=false "$@"
        echo "$role arm starting, log: $log"
    fi
    # timeout, or list_controllers waits forever when the stack never came up.
    until timeout 5 ros2 control list_controllers -c "/$role/controller_manager" 2>/dev/null \
            | grep -Eq "^$ctl( |\[).*[^n]active"; do
        if [ "$SECONDS" -ge "$end" ] || { [ -f "$pidf" ] && ! _alive "${role}_arm"; }; then
            echo "$role arm: $ctl not active (stack exited, or 30 s passed). End of $log:"
            tail -n 20 "$log"
            _alive "${role}_arm" && echo "it is still running: ${role}_off to stop it"
            return 1
        fi
        sleep 1
    done
}

# _bridge_up ROLE ID [ros args]: start the bridge node unless it is running,
# give it 10 s to fail, then show what it has said.
_bridge_up() {
    local role="$1" id="$2"; shift 2
    local name="${role}_bridge" log="$_run/${role}_bridge.log" i
    if _alive "$name"; then
        echo "$role bridge already running (pid $(_pid "$name")); ${role}_logs to follow, ${role}_down to leave"
        return 0
    fi
    if _running "$role" zrt_teleop_bridge; then
        echo "$role bridge already running outside env.sh (ros2 launch?); ${role}_leave / ${role}_join to leave / rejoin"
        return 1
    fi
    _have_bridge "$role" || return 1
    local cmd=("zrt-teleops-ros2-$role" --ros-args
               --params-file "$_config/bridge.yaml" -r "__ns:=/$role")
    # Quoted so an all-digit id stays a string.
    [ -n "$id" ] && cmd+=(-p "robot_id:='$id'")
    _spawn "$name" "${cmd[@]}" "$@"
    echo "$role bridge starting, log: $log"
    for i in $(seq 10); do
        sleep 1
        [ -f "$_run/$name.pid" ] && ! _alive "$name" && break
    done
    if ! _alive "$name"; then
        echo "$role bridge exited. End of $log:"
        tail -n 20 "$log"
        rm -f "$_run/$name.pid"
        return 1
    fi
    cat "$log"
    echo "joined the meeting as $role; ${role}_logs to follow, ${role}_down to leave"
}

# _stop NAME SECONDS: Ctrl-C NAME's process group, TERM it after SECONDS.
_stop() {
    local name="$1" secs="$2" pid i
    if ! _alive "$name"; then
        echo "${name/_/ } not running"; rm -f "$_run/$name.pid"; return 1
    fi
    pid="$(_pid "$name")"
    kill -INT -- "-$pid"
    for i in $(seq "$secs"); do _alive "$name" || break; sleep 1; done
    if _alive "$name"; then kill -TERM -- "-$pid"; sleep 3; fi
    if _alive "$name"; then
        echo "${name/_/ } still running: kill -KILL -- -$pid"; return 1
    fi
    rm -f "$_run/$name.pid"
    echo "${name/_/ } stopped"
}

_off() {
    if _alive "$1_bridge"; then _stop "$1_bridge" 15 || return 1; fi
    _stop "$1_arm" 10
}
