#!/usr/bin/env python3
"""SmolVLA policy server for the Mac -- LeRobot async inference, no teleops SDK.

    python local_setup/server.py                 # listens on 0.0.0.0:8080

The Jetson's robot_client (client.sh) sends camera frames + joints over gRPC
on the LAN; this answers with 50-step action chunks. Same as lerobot's own
policy_server, plus the two settings that made SmolVLA fast enough on the
M4 (smolvla_leader.py --check): 5 denoising steps and float32 (bf16 on MPS
was 1.13 s/chunk, fp32 + 5 steps 0.73 s). Each chunk's latency is printed.
"""

import os
import sys
import time
from concurrent import futures

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")     # before torch

import grpc
import torch
from lerobot.async_inference.configs import PolicyServerConfig
from lerobot.async_inference.policy_server import PolicyServer
from lerobot.configs.types import PolicyFeature
from lerobot.transport import services_pb2_grpc

# ── Settings ───────────────────────────────────────────────────────────────
NUM_STEPS = 10         # denoising steps; the checkpoint default, what worked on the arm (5 is ~0.1 s faster, untested)
FP32 = True            # whole model in float32: faster than bf16 on Apple GPUs
HOST, PORT = "0.0.0.0", 8080
FPS = 10               # the dataset's rate
CAM_HW = (480, 640)    # the dataset's frames, and what client.sh captures
# ───────────────────────────────────────────────────────────────────────────


class FastServer(PolicyServer):
    @property
    def policy_image_features(self):
        # lerobot resizes each frame to the config's shape (3x256x256) before the
        # policy -- squashing 640x480 into a square. Training saw 640x480, which
        # SmolVLA letterboxes itself. Keep the frames as they were trained.
        return {k: PolicyFeature(f.type, (3, *CAM_HW))
                for k, f in self.policy.config.image_features.items()}

    def SendPolicyInstructions(self, request, context):  # noqa: N802
        out = super().SendPolicyInstructions(request, context)
        self.policy.config.num_steps = NUM_STEPS
        if FP32:
            self.policy.to(torch.float32)
        print(f"  policy loaded on {self.device}: {NUM_STEPS} steps, "
              f"{'fp32' if FP32 else 'checkpoint dtype'}", flush=True)
        return out

    def _get_action_chunk(self, observation):
        t = time.perf_counter()
        chunk = super()._get_action_chunk(observation)
        print(f"  chunk {(time.perf_counter() - t) * 1e3:5.0f} ms", flush=True)
        return chunk


def main() -> None:
    cfg = PolicyServerConfig(host=HOST, port=PORT, fps=FPS)
    server = grpc.server(futures.ThreadPoolExecutor(max_workers=4))
    services_pb2_grpc.add_AsyncInferenceServicer_to_server(FastServer(cfg), server)
    server.add_insecure_port(f"{HOST}:{PORT}")
    server.start()
    print(f"policy server on {HOST}:{PORT} -- now run local_setup/client.sh on the Jetson. "
          f"ctrl-c to stop.", flush=True)
    try:
        server.wait_for_termination()
    except KeyboardInterrupt:
        server.stop(grace=1)
        sys.exit(0)


if __name__ == "__main__":
    main()
