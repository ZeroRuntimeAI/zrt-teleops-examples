#!/usr/bin/env python3
"""
Drive a robot arm with a SmolVLA policy instead of a person.

    python smolvla_leader.py

The model runs here; the arm is somewhere else. Start `so101/follower.py`
on the robot first -- nothing over there changes, because the follower
cannot tell a model from a human operator and applies the same clamps,
watchdog and deadman to both.

Needs a SmolVLA checkpoint on disk, a room id and a token. See .env.example.

    pip install "zeroruntime-teleops[lerobot]" "lerobot[smolvla]"

SETTINGS -- edit the block below the imports:

    ALIGN           refuse to arm until the arm matches the policy's first
                    output within this. None arms immediately
    ALIGN_TIMEOUT_S how long to wait for that before giving up
    SYNC_BUFFER_MS  how long to hold a frame for joint interpolation
"""

import os
import sys
import threading
import time
from pathlib import Path

import numpy as np

from dotenv import load_dotenv

from zeroruntime.teleops import Leader, NotAligned, single_group_descriptor
from zeroruntime.teleops.protocol import Units

HERE = Path(__file__).resolve().parent

# ── Settings ───────────────────────────────────────────────────────────────

#: Don't arm until the arm is this close to the policy's first output.
#: None arms immediately. See the README.
ALIGN = NONE

#: Bounded, or a gate that never opens reads as a hang.
ALIGN_TIMEOUT_S = 60.0

#: Hold each frame this long, so its joints come from the same instant.
SYNC_BUFFER_MS = 120.0

# ───────────────────────────────────────────────────────────────────────────

#: Sorted and normalized, to match the lerobot SO-101 adapter. Change
#: either and the follower refuses the session.
JOINTS = ("elbow_flex", "gripper", "shoulder_lift", "shoulder_pan",
          "wrist_flex", "wrist_roll")


def need(name: str, what: str) -> str:
    value = os.getenv(name)
    if not value:
        hint = ("  fill it in: inference/.env" if (HERE / ".env").exists()
                else "  cp inference/.env.example inference/.env")
        raise SystemExit(f"set {name} -- {what}\n{hint}")
    return value



# From THIS directory, not the working directory -- a bare load_dotenv()
# searches upward from wherever you happened to run the script.
load_dotenv(HERE / ".env")

TOKEN = need("ZRT_TOKEN", "your access token")
MEETING_ID = need("ZRT_MEETING_ID", "the room the follower is in")
FPS = int(os.getenv("ZRT_FPS", "30"))

class PolicyLeader(Leader):
    """A Leader whose joint targets come from the model.

    `read_joints()` runs inside the publish tick, so it must not block: it
    returns whatever the inference thread last produced.
    """

    def __init__(self, **kw) -> None:
        self.robot_id = "smolvla"
        self.action = {j: 0.0 for j in JOINTS}
        self._lock = threading.Lock()
        super().__init__(**kw)                     # LAST

    def descriptor(self):
        return single_group_descriptor(self.robot_id, "policy", JOINTS,
                                       control_hz=FPS, units=Units.NORMALIZED)

    def read_joints(self):
        with self._lock:
            return dict(self.action)

    def set_action(self, joints) -> None:
        with self._lock:
            self.action.update(joints)


def load_policy(path: str, task: str):
    """Load the checkpoint and return `predict(images, state) -> {joint: v}`."""
    import torch
    from lerobot.configs.policies import PreTrainedConfig
    from lerobot.policies import get_policy_class, make_pre_post_processors
    from lerobot.policies.utils import prepare_observation_for_inference

    try:
        cfg = PreTrainedConfig.from_pretrained(path)      # reads config.json
    except FileNotFoundError:
        raise SystemExit(
            f"no config.json in {path}\n"
            f"  That is not a checkpoint directory. A training run writes\n"
            f"    outputs/train/<run>/checkpoints/last/pretrained_model/\n"
            f"  and it is that directory which goes in ZRT_POLICY_PATH.") from None

    device = "cuda" if torch.cuda.is_available() else "cpu"
    cfg.device = device

    # from_pretrained, not make_policy: make_policy needs a dataset or a gym
    # env, which a box running a finished checkpoint has neither.
    policy = get_policy_class(cfg.type).from_pretrained(path, config=cfg)
    policy.eval()
    policy.reset()          # creates the action queue -- required

    try:
        pre, post = make_pre_post_processors(
            policy_cfg=cfg, pretrained_path=path,
            preprocessor_overrides={"device_processor": {"device": device}},
            postprocessor_overrides={"device_processor": {"device": "cpu"}})
    except Exception as exc:
        # Pre-0.6 checkpoints keep normalization inside the weights. Most
        # community checkpoints on the Hub are still that shape.
        if "migration" not in str(exc).lower():
            raise
        raise SystemExit(
            f"{path}\n"
            f"  is a pre-0.6 checkpoint: its normalization lives in the "
            f"weights rather\n  than in processor files. Convert it once, "
            f"then point at the copy:\n\n"
            f"    python -m lerobot.processor.migrate_policy_normalization "
            f"\\\n        --pretrained-path {path}\n\n"
            f"  It writes a new directory suffixed `_migrated`.") from None

    cams = [k.removeprefix("observation.images.") for k in cfg.image_features]
    width = cfg.output_features["action"].shape[0]
    if width != len(JOINTS):
        raise SystemExit(
            f"the checkpoint outputs {width} actions but this robot has "
            f"{len(JOINTS)} joints.\n  It was trained on a different machine.")

    # The wire says `shoulder_pan`; the dataset says `shoulder_pan.pos`.
    order = [f"{j}.pos" for j in JOINTS]
    print(f"  {cfg.type} on {device}, cameras {cams}, task {task!r}")

    def predict(images, state):
        obs = {}
        for key in cfg.image_features:
            frame = images.get(key.removeprefix("observation.images."))
            if frame is None:
                return {}           # a camera it wants is missing; hold
            obs[key] = _rgb(frame)

        obs["observation.state"] = np.array(
            [state.get(k[:-4], 0.0) for k in order], dtype=np.float32)

        # `task` is tokenized in the preprocessor, which also normalizes.
        # Do neither here.
        batch = prepare_observation_for_inference(
            obs, torch.device(device), task, "so101_follower")
        with torch.inference_mode():
            action = post(policy.select_action(pre(batch)))
        return {j: float(v) for j, v in zip(JOINTS, action.squeeze(0))}

    return predict


def _rgb(frame):
    """One received frame as `(h, w, 3)` uint8 RGB.

    The wire carries planar I420 -- `frame.array` is `(h*3//2, w)`, not an
    image, and passing it to the model raises no error. No resize here:
    SmolVLA pads and resizes internally.
    """
    import cv2
    return cv2.cvtColor(frame.array, cv2.COLOR_YUV2RGB_I420)


def infer_forever(leader, predict, stop: threading.Event) -> None:
    """Run the model off the control loop, writing each result to `leader`.

    Its own thread because inference inside `tick()` would stall the command
    stream, which is exactly what the follower's watchdog measures. Here a
    slow model just changes the target less often.
    """
    while not stop.is_set():
        obs = leader.observation()      # joints + a frame per camera
        if not obs.images:
            time.sleep(0.05)            # no video yet; normal for a second
            continue
        try:
            leader.set_action(predict(obs.images, obs.joints))
        finally:
            for frame in obs.images.values():
                frame.release()         # or decoder buffers pin


def _progress():
    """Show alignment while waiting -- a silent gate looks like a hang."""
    last = 0.0

    def on_status(aligned, delta, seconds_left):
        nonlocal last
        if time.monotonic() - last < 1.0:
            return
        last = time.monotonic()
        if not delta:
            print("  waiting for the robot's pose")
        elif aligned:
            print(f"  aligned, holding... {seconds_left:.1f}s")
        else:
            worst = max(delta, key=lambda j: abs(delta[j]))
            print(f"  off by {delta[worst]:+7.1f} on {worst}")

    return on_status


def main() -> None:
    predict = load_policy(
        need("ZRT_POLICY_PATH", "the checkpoint directory (with config.json)"),
        need("ZRT_TASK", "what the policy was trained to do -- SmolVLA is "
                         "conditioned on it"))

    leader = PolicyLeader(meeting_id=MEETING_ID, token=TOKEN, publish_hz=FPS,
                          max_misalignment=ALIGN,
                          sync_buffer_ms=SYNC_BUFFER_MS)

    @leader.on_ready
    def _(desc):
        print(f"robot online: {desc.robot_id}, schema {desc.schema_hash}")

    leader.start()
    if not leader.claim_control(timeout_s=10):
        raise SystemExit(f"no control: no follower answered in {MEETING_ID}")
    print(f"control granted, schema {leader.schema}")

    # BEFORE arming: the gate reads the policy's output, which does not
    # exist until inference has run once.
    stop = threading.Event()
    worker = threading.Thread(target=infer_forever, args=(leader, predict, stop),
                              name="inference", daemon=True)
    worker.start()

    if ALIGN is None:
        leader.hold_deadman(True)
    else:
        print(f"waiting until every joint is within {ALIGN}...")
        try:
            leader.arm_when_aligned(timeout=ALIGN_TIMEOUT_S,
                                    on_status=_progress())
        except NotAligned as exc:
            stop.set()
            delta = leader.alignment() or {}
            worst = max(delta, key=lambda j: abs(delta[j])) if delta else None
            sys.exit(
                f"never armed: {exc}\n"
                + (f"  furthest: {worst} off by {delta[worst]:+.1f}\n"
                   if worst else "")
                + "  This policy wants a pose that far from where the arm is\n"
                  "  standing. Move the arm closer, or set ALIGN = None at\n"
                  "  the top of this file and lower ZRT_SLEW on the robot.")
    print("armed, the policy is driving. ctrl-c to stop.")

    try:
        for i in leader.ticks(hz=FPS):
            if i % (FPS * 2) == 0:
                # in flight = sent but not yet applied. A rising count
                # means the policy is outrunning the control rate.
                print(f"tick {i:5d}  sent={leader.commands_sent}  "
                      f"in flight={leader.seq - leader.applied_seq}  "
                      f"{leader.robot_safe_state}")
            if not worker.is_alive():
                raise SystemExit("the inference thread died -- see above")
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        # Stops the command stream; the follower's watchdog then holds
        # the arm. Does not depend on the model cooperating.
        leader.hold_deadman(False)
        worker.join(timeout=2.0)
        leader.stop()


if __name__ == "__main__":
    main()
