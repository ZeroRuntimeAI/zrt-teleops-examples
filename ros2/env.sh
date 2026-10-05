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

# -- join and leave ----------------------------------------------------------
# <role>_up starts the arm stack (driver + controllers) in the background,
# logging to .run/<role>_arm.log -- or reuses the one already running -- then
# starts the bridge in the background too, logging to .run/<role>_bridge.log,
# and gives the prompt back once it has joined. Both run in their own session:
# closing the terminal, ssh or `docker exec` stops neither.
# Anything after <role>_up goes to `ros2 launch`, e.g. usb_port:=/dev/ttyACM1.
follower_up() { _arm_up follower forward_controller hardware:=feetech \
                    usb_port:="$ZRT_FOLLOWER_PORT" "$@" && _bridge_up follower "$ZRT_FOLLOWER_ID"; }
leader_up()   { _arm_up leader joint_state_broadcaster hardware:=feetech \
                    usb_port:="$ZRT_LEADER_PORT" "$@" && _bridge_up leader "$ZRT_LEADER_ID"; }

# <role>_down stops only the bridge: it leaves the meeting. The arm stack keeps
# running, so the follower holds its last command; <role>_up rejoins.
follower_down() { _stop follower_bridge 15 && echo "left the meeting; the follower arm keeps" \
                      "holding (forward_controller keeps the last command); follower_off to power it down"; }
leader_down()   { _stop leader_bridge 15 && echo "left the meeting"; }

# <role>_off powers the arm down: leaves the meeting if still in it, then
# stops the stack. That turns the follower's torque off: the arm drops.
follower_off() {
    if _alive follower_arm; then
        echo "follower_off turns the servos' torque off: the arm DROPS."
        read -r -p "Support the arm, then press Enter (Ctrl-C to cancel) " || return 1
    fi
    _off follower
}
leader_off() { _off leader; }   # no torque on the leader, nothing drops

# <role>_logs follows the bridge's log. Ctrl-C stops only the tail.
follower_logs() { tail -n 50 -F "$_run/follower_bridge.log"; }
leader_logs()   { tail -n 50 -F "$_run/leader_bridge.log"; }

# -- no arm ------------------------------------------------------------------
# The follower on mock_components: the commanded position becomes the state.
# Same stack slot as follower_up, so follower_down / follower_off stop it.
follower_mock() { _arm_up follower forward_controller hardware:=mock "$@" \
                      && _bridge_up follower "$ZRT_FOLLOWER_ID"; }
# The leader is just the bridge; fake_leader stands in for the arm. No mock
# stack here: its joint_state_broadcaster would publish /leader/joint_states
# too and fight fake_leader. Anything after leader_mock goes to the bridge.
# leader_down stops it.
leader_mock() { _bridge_up leader "$ZRT_LEADER_ID" "$@"; }
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
# NAME below is <role>_arm or <role>_bridge: .run/NAME.pid holds its process
# group id (setsid makes it the leader), .run/NAME.log its output.
_pid()   { cat "$_run/$1.pid" 2>/dev/null; }
# A process that died leaves a zombie, and its group still answers kill -0.
_alive() { local p; p="$(_pid "$1")" && [ -n "$p" ] \
               && kill -0 -- "-$p" 2>/dev/null \
               && [ "$(ps -o state= -p "$p" 2>/dev/null)" != Z ]; }

# _spawn NAME CMD...: CMD in its own session, with no terminal, so Ctrl-C here
# and a closed terminal never reach it. setsid -f rather than `&`: a
# background job of a script ignores SIGINT, and SIGINT is how both stop
# cleanly. The child writes its own pid, the pidfile appears just after.
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
    else
        _spawn "${role}_arm" ros2 launch "$ZRT_ROS2/bringup/launch/$role.launch.py" bridge:=false "$@"
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

# _off ROLE: leave the meeting if still in it, then stop the arm stack.
_off() {
    if _alive "$1_bridge"; then _stop "$1_bridge" 15 || return 1; fi
    _stop "$1_arm" 10
}
