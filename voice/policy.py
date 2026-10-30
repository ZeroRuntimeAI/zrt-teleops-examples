"""
EXPERIMENTAL: pick things up with MolmoAct2, no training.

`allenai/MolmoAct2-SO100_101` is the one public checkpoint trained on this
arm. On a scene it has never seen, it is a best effort: expect misses. The
agent says it is trying, and looks before saying it worked.

Turned on by ZERORUNTIME_PICKUP=1 in voice/.env. Needs

    pip install transformers pillow

and 21.8 GB on first load. On an M5 MacBook Pro it takes ~14 GB of memory
and ~1.2 s per 30-step chunk once warm.

UNITS: MolmoAct2 wants absolute joint pose in degrees, which is what a stock
lerobot SO-101 follower publishes -- but measured from a different zero.
TO_MODEL converts; get it wrong and nothing raises, the arm just reaches
for the wrong place. motion.guard_chunk refuses a chunk that tries to jump.
"""

import time

import numpy as np

REPO = "allenai/MolmoAct2-SO100_101"

#: The checkpoint's tag into its norm_stats.json. Wrong tag, wrong scaling.
NORM_TAG = "so100_so101_molmoact2"

#: Flow-solver steps: the model card's default.
NUM_STEPS = 10

#: The model predicts 30 rows; asking for more silently returns fewer.
HORIZON = 30

#: Throwaway inferences at load. Apple's MPS compiles on the first calls --
#: measured 31 s, 8 s, 2 s, then ~1.2 s -- and that belongs at startup, not
#: in the first "pick up the cube".
WARMUP = 3

#: How MolmoAct2 stacks joints: lerobot's declaration order, NOT the wire's
#: sorted one. Mixed up, nothing raises and the arm moves confidently wrong.
ORDER = ("shoulder_pan", "shoulder_lift", "elbow_flex", "wrist_flex",
         "wrist_roll", "gripper")

#: model = sign * arm + offset, per joint. lerobot >= 0.5 calibrates each
#: joint to 0 at the middle of its travel; the SO-100/101 data MolmoAct2
#: learned from uses the older convention -- 0 is the arm straight out, the
#: folded rest is ~180. Read off the checkpoint's own sample (an SO-101 at
#: rest: lift 189, elbow 181) against a lerobot 0.6 arm at rest (lift -100,
#: elbow +100). pan and roll centre the same; their SIGNS are unverified --
#: the README's dry run checks which way pan heads for an object. The
#: gripper is 0-100 here but tops out near 44 in the model's data: told
#: "open" (98 here) it answered 44.5, its own "open".
TO_MODEL = {
    "shoulder_pan": (1.0, 0.0),
    "shoulder_lift": (-1.0, 90.0),
    "elbow_flex": (1.0, 90.0),
    "wrist_flex": (1.0, 0.0),
    "wrist_roll": (1.0, 0.0),
    "gripper": (0.45, 0.0),
}


def state_vector(joints) -> np.ndarray:
    """The arm's pose as MolmoAct2 expects it: its order, its convention."""
    missing = [j for j in ORDER if j not in joints]
    if missing:
        raise ValueError(f"no state for {', '.join(missing)}")
    return np.asarray([TO_MODEL[j][0] * joints[j] + TO_MODEL[j][1]
                       for j in ORDER], dtype=np.float32)


def rows_from_actions(actions) -> list[dict]:
    """The model's (..., horizon, 6) output as chunk rows in THIS arm's
    convention, capped at HORIZON. A NaN target is not a pose: refused."""
    a = np.asarray(actions, dtype=np.float32)
    a = a.reshape(-1, a.shape[-1])[:HORIZON]
    if a.shape[-1] != len(ORDER):
        raise ValueError(f"the model returned {a.shape[-1]} joints, "
                         f"this arm has {len(ORDER)}")
    if not np.isfinite(a).all():
        raise ValueError("the model returned non-finite actions")
    return [{j: float((v - TO_MODEL[j][1]) / TO_MODEL[j][0])
             for j, v in zip(ORDER, row)} for row in a]


def to_rgb(frame) -> np.ndarray:
    """One received frame as (h, w, 3) uint8 RGB. The wire carries planar
    I420: `frame.array` is (h*3//2, w), not an image -- and a model handed
    it raises no error."""
    import cv2
    return cv2.cvtColor(frame.array, cv2.COLOR_YUV2RGB_I420)


def load_policy():
    """Load MolmoAct2, warm it up, and return infer(observation, task) -> rows."""
    import torch
    from PIL import Image
    from transformers import AutoModelForImageTextToText, AutoProcessor

    device = ("mps" if torch.backends.mps.is_available() else
              "cuda" if torch.cuda.is_available() else "cpu")
    print(f"pick-up: loading {REPO} on {device} "
          f"(the first time downloads 21.8 GB) ...")
    t0 = time.perf_counter()
    processor = AutoProcessor.from_pretrained(REPO, trust_remote_code=True)
    model = AutoModelForImageTextToText.from_pretrained(
        REPO, trust_remote_code=True, dtype=torch.bfloat16).to(device).eval()

    def predict(images, state, task: str) -> list[dict]:
        with torch.inference_mode():
            out = model.predict_action(
                processor=processor, images=images, task=task, state=state,
                norm_tag=NORM_TAG, inference_action_mode="continuous",
                enable_depth_reasoning=False, num_steps=NUM_STEPS,
                enable_cuda_graph=device == "cuda")
        actions = (out.actions.float().cpu() if torch.is_tensor(out.actions)
                   else out.actions)
        return rows_from_actions(actions)

    # A real-length task: MPS recompiles for a new prompt length, so warming
    # up on "warm up" still left the first real pick-up ~9 s slow.
    blank = Image.new("RGB", (640, 480), (128, 128, 128))
    for _ in range(WARMUP):
        predict([blank, blank], np.zeros(len(ORDER), np.float32),
                "pick up the red cube")
    print(f"pick-up: ready in {time.perf_counter() - t0:.0f}s")

    def infer(obs, task: str) -> list[dict]:
        # The controller releases the frames after this returns.
        images = [Image.fromarray(to_rgb(f)) for f in obs.images.values()]
        return predict(images, state_vector(obs.joints), task)

    return infer
