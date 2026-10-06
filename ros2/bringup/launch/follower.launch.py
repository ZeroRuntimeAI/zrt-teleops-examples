"""
The follower machine: one SO-101 driven over ros2_control, and the bridge
that takes commands from the room and sends it video and state back.

Two terminals. T1 brings the arm up and joins the meeting, and stays in
the foreground:

    ros2 launch so101_teleop_bringup follower.launch.py

T2 is for commands: `source env.sh`, then record_on, follower_estop, ...

Everything lives under /follower:
    /follower/joint_states                    joint_state_broadcaster -> bridge
    /follower/forward_controller/commands     bridge -> forward_controller
                                              (Float64MultiArray, joint_names order)
    /follower/zrt_teleop_bridge/estop         latch an e-stop here
    /follower/zrt_teleop_bridge/clear_estop   clear it (only here, on purpose)
    /follower/zrt_teleop_bridge/recording     start / stop recording (SetBool)
    /follower/zrt_teleop_bridge/episode       start / end an episode (SetBool)
    /follower/zrt_teleop_bridge/join          leave (false) / rejoin (true) the meeting

When the room goes quiet the bridge stops publishing and forward_controller
holds the last command: the arm holds, it does not fall. Ctrl-C on THIS
launch is different: it stops the driver too, torque goes off and the arm
DROPS (support it first). To leave the meeting with the arm still holding,
`follower_leave` from T2 (~/join false); `follower_join` rejoins.

Args: hardware:=feetech|mock, usb_port (default $ZRT_FOLLOWER_PORT),
robot_id (default $ZRT_FOLLOWER_ID), bridge:=true|false (false to run the
bridge yourself, e.g. under a debugger).
"""

import os

import xacro
import yaml
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, ExecuteProcess, OpaqueFunction
from launch.substitutions import EnvironmentVariable
from launch_ros.actions import Node

ROLE = "follower"
BRINGUP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def check_joint_order():
    # The command is a bare positional array; forward_controller only checks
    # its length, so a reordered list would drive the wrong servos.
    def load(name):
        with open(os.path.join(BRINGUP, "config", name)) as f:
            return yaml.safe_load(f)
    controller = load(f"{ROLE}_controllers.yaml")["/**/forward_controller"]["ros__parameters"]["joints"]
    bridge = load("bridge.yaml")["/**"]["ros__parameters"]["joint_names"]
    if controller != bridge:
        raise RuntimeError(
            f"forward_controller joints {controller} (follower_controllers.yaml) != "
            f"joint_names {bridge} (bridge.yaml): same joints, same order")


def setup(context):
    check_joint_order()
    arg = context.launch_configurations
    hardware = arg["hardware"]
    if hardware not in ("feetech", "mock"):
        raise RuntimeError(f"hardware must be feetech or mock, got {hardware!r}")
    if hardware == "feetech":
        # One line instead of a driver stack trace.
        if not os.path.exists(arg["usb_port"]):
            raise RuntimeError(f"usb_port {arg['usb_port']} does not exist (unplugged?)")

    urdf = xacro.process_file(
        os.path.join(BRINGUP, "urdf", "so101.urdf.xacro"),
        mappings={"role": ROLE, "hardware": hardware,
                  "usb_port": arg["usb_port"]}).toxml()

    actions = [
        Node(package="robot_state_publisher", executable="robot_state_publisher",
             namespace=ROLE,
             parameters=[{"robot_description": urdf, "frame_prefix": f"{ROLE}/"}]),
        Node(package="controller_manager", executable="ros2_control_node",
             namespace=ROLE, output="both",
             parameters=[os.path.join(BRINGUP, "config", f"{ROLE}_controllers.yaml")]),
        Node(package="controller_manager", executable="spawner",
             namespace=ROLE,
             arguments=["joint_state_broadcaster", "forward_controller",
                        "--controller-manager", f"/{ROLE}/controller_manager"]),
    ]

    if arg["bridge"].lower() == "true":
        cmd = ["zrt-teleops-ros2-follower", "--ros-args",
               "--params-file", os.path.join(BRINGUP, "config", "bridge.yaml"),
               "-r", f"__ns:=/{ROLE}"]
        if arg["robot_id"]:
            # Quoted so an all-digit id stays a string.
            cmd += ["-p", f"robot_id:='{arg['robot_id']}'"]
        # sigterm_timeout: leaving the room cleanly takes a few seconds.
        actions.append(ExecuteProcess(cmd=cmd, output="screen",
                                      sigterm_timeout="10"))
    return actions


def generate_launch_description():
    return LaunchDescription([
        DeclareLaunchArgument("hardware", default_value="feetech"),
        # From .env, so T1 needs no args.
        DeclareLaunchArgument("usb_port", default_value=EnvironmentVariable(
            "ZRT_FOLLOWER_PORT", default_value="/dev/ttyACM0")),
        DeclareLaunchArgument("robot_id", default_value=EnvironmentVariable(
            "ZRT_FOLLOWER_ID", default_value="")),
        DeclareLaunchArgument("bridge", default_value="true"),
        OpaqueFunction(function=setup),
    ])
