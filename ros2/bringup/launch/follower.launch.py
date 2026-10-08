"""
The follower machine: one SO-101 driven over ros2_control, and the bridge
that takes commands from the room and sends it video and state back.

    ros2 launch so101_teleop_bringup follower.launch.py

Then, in a command terminal, `source env.sh` for start_recording,
follower_estop, ...

When the room goes quiet the arm holds its last command. Ctrl-C HERE stops
the driver too: torque goes off and only the gears hold the arm, so a
loaded pose can sag or drop. Support it first.
`follower_leave` leaves the meeting with the arm still holding.

Args: hardware:=feetech|mock, usb_port (default $ZERORUNTIME_FOLLOWER_PORT),
robot_id (default $ZERORUNTIME_FOLLOWER_ID), bridge:=false to run the bridge yourself.
"""

import os
import shutil

import xacro
import yaml
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, ExecuteProcess, OpaqueFunction
from launch.substitutions import EnvironmentVariable
from launch_ros.actions import Node

ROLE = "follower"
BRINGUP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def check_joint_order():
    # The command is a bare positional array: a reordered list drives the wrong servos.
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
    # Before the arm comes up: without the bridge it would never join.
    if arg["bridge"].lower() == "true" and not shutil.which(f"zrt-teleops-ros2-{ROLE}"):
        raise RuntimeError(f"zrt-teleops-ros2-{ROLE} not found: activate the SDK's venv first")

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
        DeclareLaunchArgument("usb_port", default_value=EnvironmentVariable(
            "ZERORUNTIME_FOLLOWER_PORT", default_value="/dev/ttyACM0")),
        DeclareLaunchArgument("robot_id", default_value=EnvironmentVariable(
            "ZERORUNTIME_FOLLOWER_ID", default_value="")),
        DeclareLaunchArgument("bridge", default_value="true"),
        OpaqueFunction(function=setup),
    ])
