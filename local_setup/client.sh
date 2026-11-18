#!/usr/bin/env bash
# Robot client for the Jetson: reads the arm + 3 USB cameras directly and runs
# SmolVLA's chunks from the Mac's server.py over the LAN. No teleops SDK.
#
#   bash ~/zrt-teleops-examples/local_setup/client.sh
#
# Stop the teleops follower first -- it holds the same serial port:
#   systemctl --user stop follower
#
# Camera keys are camera1/2/3 -- the checkpoint's own names -- so no rename
# map is needed: camera1 = top (USB 2.2), camera2 = wrist (2.1), camera3 = side (2.4).
set -euo pipefail

SERVER=${SERVER:-10.0.1.26:8080}                               # the Mac
POLICY=${POLICY:-/Users/karanrajput/so101_dataset/checkpoints/last/pretrained_model}  # path ON THE MAC
TASK=${TASK:-pick up the orange cube and place it in the white bowl}
PORT=${PORT:-/dev/serial/by-path/platform-3610000.usb-usb-0:2.3:1.0}
ARM_ID=${ARM_ID:-my_awesome_follower_arm}                      # lerobot calibration name
MAX_STEP=${MAX_STEP:-10}       # per-command joint clamp (normalized units); the SDK follower clamped ~8/step

cam() { echo "{type: opencv, index_or_path: /dev/v4l/by-path/platform-3610000.usb-usb-0:$1:1.0-video-index0, width: 640, height: 480, fps: 30, fourcc: MJPG}"; }

cd ~/zrt-teleops-examples
exec venv/bin/python -m lerobot.async_inference.robot_client \
  --robot.type=so101_follower \
  --robot.port="$PORT" \
  --robot.id="$ARM_ID" \
  --robot.max_relative_target="$MAX_STEP" \
  --robot.cameras="{camera1: $(cam 2.2), camera2: $(cam 2.1), camera3: $(cam 2.4)}" \
  --task="$TASK" \
  --server_address="$SERVER" \
  --policy_type=smolvla \
  --pretrained_name_or_path="$POLICY" \
  --policy_device=mps \
  --actions_per_chunk=50 \
  --chunk_size_threshold=0.5 \
  --aggregate_fn_name=weighted_average \
  --fps=10
