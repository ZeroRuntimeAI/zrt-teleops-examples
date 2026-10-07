"""
The leader machine: one SO-101 read over ros2_control, and the bridge that
sends it into the room.

    ros2 launch so101_teleop_bringup leader.launch.py

Then, in a second terminal, `source env.sh` for take_control,
release_control, estop, ...

The arm has no command interface, so its torque stays off: Ctrl-C here is
harmless.

Args: hardware:=feetech|mock, usb_port (default $ZRT_LEADER_PORT),
robot_id (default $ZRT_LEADER_ID), bridge:=false to run the bridge yourself.
"""

import os
import shutil

import xacro
from launch import LaunchDescription
from launch.actions import DeclareLaunchArgument, ExecuteProcess, OpaqueFunction
from launch.substitutions import EnvironmentVariable
from launch_ros.actions import Node

ROLE = "leader"
BRINGUP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def setup(context):
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
             arguments=["joint_state_broadcaster",
                        "--controller-manager", f"/{ROLE}/controller_manager"]),
    ]

    if arg["bridge"].lower() == "true":
        cmd = ["zrt-teleops-ros2-leader", "--ros-args",
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
            "ZRT_LEADER_PORT", default_value="/dev/ttyACM0")),
        DeclareLaunchArgument("robot_id", default_value=EnvironmentVariable(
            "ZRT_LEADER_ID", default_value="")),
        DeclareLaunchArgument("bridge", default_value="true"),
        OpaqueFunction(function=setup),
    ])
