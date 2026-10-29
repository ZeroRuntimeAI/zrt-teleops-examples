#!/usr/bin/env python3
"""
SmolVLA leader -- run this on any machine with a GPU: a cloud box, a
notebook, a Jetson next to the arm, or a Mac.

    python smolvla_leader.py --policy user/my_smolvla --task "pick up the cube" --check
    python smolvla_leader.py --policy user/my_smolvla --task "pick up the cube"

Run --check first on a new machine. It loads the checkpoint without the robot,
times inference and tells you if this machine is fast enough. On a Jetson or
a laptop, add --num-steps 5.

Start follower.py on the robot first. When the leader takes control, the arm
moves smoothly to the pose the training episodes started from, then the
policy takes over. Inference runs while the arm moves, so a slow GPU never
makes the arm stop and wait.

Camera names, joint order and the control rate are read from the checkpoint
and its dataset, and printed at startup. Check those lines before arming.

Needs ZERORUNTIME_AUTH_TOKEN and ZERORUNTIME_MEETING_ID -- see .env.example.
Every setting is also a flag; run with --help for the full list.
"""

import argparse
import json
import os
import threading
import time
import traceback
import warnings
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent

# Must be set before torch is imported.
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

# Jetson Orin builds of torch warn about sm_87 even though they work.
warnings.filterwarnings("ignore", message=".*compute capability.*")

#: Joint order on the wire. The follower expects exactly this.
JOINTS = ("elbow_flex", "gripper", "shoulder_lift", "shoulder_pan",
          "wrist_flex", "wrist_roll")

#: Joint order in datasets recorded with lerobot.
LEROBOT_ORDER = ("shoulder_pan", "shoulder_lift", "elbow_flex",
                 "wrist_flex", "wrist_roll", "gripper")

#: Slower than this per chunk and the arm tends to miss grasps.
FRESH_S = 0.75

#: Speed limit per joint, in units per second.
DEFAULT_MAX_SPEED = {"shoulder_pan": 80.0, "shoulder_lift": 80.0,
                     "elbow_flex": 80.0, "wrist_flex": 100.0,
                     "wrist_roll": 100.0, "gripper": 150.0}


# ── Settings ───────────────────────────────────────────────────────────────

@dataclass
class Settings:
    policy: str = ""
    task: str = ""
    token: str = ""
    meeting_id: str = ""
    fps: int = 30
    policy_hz: float | None = None
    dataset: str | None = None
    camera_map: dict = field(default_factory=dict)
    joint_order: tuple | None = None
    device: str | None = None
    num_steps: int | None = None
    prefetch_s: float | None = None
    blend_steps: int = 10
    max_speed: dict = field(default_factory=lambda: dict(DEFAULT_MAX_SPEED))
    sync_buffer_ms: float = 120.0
    first_chunk_timeout_s: float = 120.0
    fp32: bool = False
    home: str = "dataset"
    home_speed: float = 30.0
    home_min_s: float = 1.5
    home_settle_s: float = 0.5
    ramp_s: float = 1.5
    check: bool = False
    verbose: bool = False


def _env(name, default=None):
    v = os.getenv(name)
    return v if v not in (None, "") else default


def parse_args() -> Settings:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--env-file", help="extra .env to load (default: .env next to this file)")
    p.add_argument("--policy", help="SmolVLA checkpoint dir or Hub repo id "
                                    "[ZERORUNTIME_POLICY_PATH]")
    p.add_argument("--task", help="training task text, word for word [ZERORUNTIME_TASK]")
    p.add_argument("--token", help="[ZERORUNTIME_AUTH_TOKEN]")
    p.add_argument("--meeting-id", help="[ZERORUNTIME_MEETING_ID]")
    p.add_argument("--fps", type=int, help="control rate to the follower [ZERORUNTIME_FPS, 30]")
    p.add_argument("--policy-hz", type=float, help="dataset fps [ZERORUNTIME_POLICY_HZ]")
    p.add_argument("--dataset", help="dataset dir or Hub id, for fps + joint order "
                                     "[ZERORUNTIME_DATASET_ROOT]")
    p.add_argument("--camera-map", help="slot=label,... e.g. camera1=top,camera2=wrist "
                                        "[ZERORUNTIME_CAMERA_MAP]")
    p.add_argument("--joint-order", help="'lerobot', 'sorted', or a comma list "
                                         "[ZERORUNTIME_JOINT_ORDER]")
    p.add_argument("--device", help="cuda | cuda:N | mps | cpu [ZERORUNTIME_DEVICE, auto]")
    p.add_argument("--num-steps", type=int, help="denoising steps; 5 ~2x faster "
                                                 "[ZERORUNTIME_NUM_STEPS]")
    p.add_argument("--prefetch-s", help="seconds of actions left when the next inference "
                                        "starts, or 'auto' [ZERORUNTIME_PREFETCH_S, auto]")
    p.add_argument("--blend-steps", type=int, help="crossfade length in actions [10]")
    p.add_argument("--max-speed", help="units/s per joint, e.g. gripper=150,"
                                       "shoulder_lift=80 (merged into the defaults)")
    p.add_argument("--sync-buffer-ms", type=float, help="[120]")
    p.add_argument("--fp32", action="store_true", help="run the whole model in float32; "
                   "compare speed with --check (Apple GPUs without fast bf16) [ZERORUNTIME_FP32]")
    p.add_argument("--home", help="start pose before the policy: 'dataset' (median first "
                   "frame of the training episodes), 'current' (no move), or 6 values in "
                   "SO-101 order / name=value pairs [ZERORUNTIME_HOME, dataset]")
    p.add_argument("--home-speed", type=float, help="homing speed, units/s [30]")
    p.add_argument("--ramp-s", type=float, help="seconds to fade into the first chunk [1.5]")
    p.add_argument("--check", action="store_true", help="load and infer only, no robot")
    p.add_argument("-v", "--verbose", action="store_true", help="per-chunk timing")
    a = p.parse_args()

    load_dotenv(HERE / ".env")
    if a.env_file:
        load_dotenv(a.env_file, override=True)

    s = Settings()
    s.policy = a.policy or _env("ZERORUNTIME_POLICY_PATH", "")
    s.task = a.task or _env("ZERORUNTIME_TASK", "")
    s.token = a.token or _env("ZERORUNTIME_AUTH_TOKEN", "")
    s.meeting_id = a.meeting_id or _env("ZERORUNTIME_MEETING_ID", "")
    s.fps = a.fps or int(_env("ZERORUNTIME_FPS", "30"))
    hz = a.policy_hz or _env("ZERORUNTIME_POLICY_HZ")
    s.policy_hz = float(hz) if hz else None
    s.dataset = a.dataset or _env("ZERORUNTIME_DATASET_ROOT")
    cm = a.camera_map or _env("ZERORUNTIME_CAMERA_MAP")
    if cm:
        s.camera_map = dict(x.split("=", 1) for x in cm.replace(" ", "").split(",") if x)
    jo = a.joint_order or _env("ZERORUNTIME_JOINT_ORDER")
    if jo:
        s.joint_order = (LEROBOT_ORDER if jo == "lerobot" else JOINTS if jo == "sorted"
                         else tuple(x.strip().removesuffix(".pos") for x in jo.split(",")))
    s.device = a.device or _env("ZERORUNTIME_DEVICE")
    ns = a.num_steps or _env("ZERORUNTIME_NUM_STEPS")
    s.num_steps = int(ns) if ns else None
    pf = a.prefetch_s or _env("ZERORUNTIME_PREFETCH_S", "auto")
    s.prefetch_s = None if str(pf).lower() == "auto" else float(pf)
    if a.blend_steps is not None:
        s.blend_steps = a.blend_steps
    if a.max_speed:
        for kv in a.max_speed.split(","):
            k, v = kv.split("=", 1)
            s.max_speed[k.strip()] = float(v)
    if a.sync_buffer_ms is not None:
        s.sync_buffer_ms = a.sync_buffer_ms
    s.fp32 = a.fp32 or _env("ZERORUNTIME_FP32", "0").lower() in ("1", "true", "yes")
    s.home = a.home or _env("ZERORUNTIME_HOME", "dataset")
    if a.home_speed:
        s.home_speed = a.home_speed
    if a.ramp_s is not None:
        s.ramp_s = a.ramp_s
    s.check, s.verbose = a.check, a.verbose

    def need(value, flag, env, what):
        if not value:
            hint = ("  fill it in: inference/.env" if (HERE / ".env").exists()
                    else "  cp inference/.env.example inference/.env")
            raise SystemExit(f"set {env} (or {flag}) -- {what}\n{hint}")
    need(s.policy, "--policy", "ZERORUNTIME_POLICY_PATH",
         "the checkpoint dir (with config.json) or a Hub repo id")
    need(s.task, "--task", "ZERORUNTIME_TASK",
         "the training task, word for word -- SmolVLA is conditioned on it")
    if not s.check:
        need(s.token, "--token", "ZERORUNTIME_AUTH_TOKEN", "your access token")
        need(s.meeting_id, "--meeting-id", "ZERORUNTIME_MEETING_ID",
             "the room the follower is in")
    return s


# ── Checkpoint ─────────────────────────────────────────────────────────────

def resolve_checkpoint(spec: str) -> Path:
    """Find the policy in a local folder or a Hub repo."""
    local = Path(spec).expanduser()
    if local.exists():
        for cand in (local, local / "pretrained_model",
                     local / "checkpoints" / "last" / "pretrained_model"):
            if _is_policy_dir(cand):
                return cand.resolve()
        raise SystemExit(f"no policy config.json under {local}\n  point --policy at "
                         f"the pretrained_model folder (config.json + model.safetensors)")

    from huggingface_hub import list_repo_files, snapshot_download
    parts = spec.strip("/").split("/")
    repo, prefix = "/".join(parts[:2]), "/".join(parts[2:])
    try:
        files = list_repo_files(repo)
    except Exception as exc:
        raise SystemExit(f"{spec}: not a local folder, and the Hub refused it "
                         f"({exc.__class__.__name__}).\n  If the repo is gated or private, "
                         f"accept its conditions on huggingface.co,\n  then run "
                         f"`hf auth login` or set HF_TOKEN.") from None
    def is_policy(f):
        parent = str(Path(f).parent)
        weights = "model.safetensors" if parent == "." else f"{parent}/model.safetensors"
        return Path(f).name == "config.json" and f.startswith(prefix) and weights in files

    # Prefer the top-level policy, then checkpoints/last.
    configs = sorted(filter(is_policy, files),
                     key=lambda f: (f.count("/"), "/last/" not in f"/{f}", f))
    if not configs:
        raise SystemExit(f"no config.json + model.safetensors in {spec}")
    sub = str(Path(configs[0]).parent)
    sub = "" if sub == "." else sub
    print(f"  downloading {repo}{'/' + sub if sub else ''} ...")
    root = snapshot_download(repo, allow_patterns=[f"{sub}/*" if sub else "*"])
    return (Path(root) / sub).resolve()


def _is_policy_dir(p: Path) -> bool:
    try:
        return "type" in json.loads((p / "config.json").read_text())
    except Exception:
        return False


_refused = set()


def _hub_refused(repo: str, exc: Exception) -> None:
    """Say once why a dataset on the Hub could not be read."""
    if repo not in _refused:
        _refused.add(repo)
        print(f"  dataset {repo}: the Hub refused access ({exc.__class__.__name__}). "
              f"If it is gated, accept its\n  conditions on huggingface.co and set "
              f"HF_TOKEN; until then fps, joint order and start pose use defaults.")


def read_train_config(ckpt: Path) -> dict:
    f = ckpt / "train_config.json"
    return json.loads(f.read_text()) if f.exists() else {}


def dataset_file(s: Settings, train_cfg: dict, rel: str) -> dict | None:
    """Read a JSON file from the training dataset, local or on the Hub."""
    ds = train_cfg.get("dataset") or {}
    cands = [c for c in (s.dataset, ds.get("root"), ds.get("repo_id")) if c]
    for c in cands:
        p = Path(c).expanduser()
        if (p / rel).exists():
            return json.loads((p / rel).read_text())
        if p.exists() or str(c).startswith("local/") or str(c).count("/") != 1:
            continue
        try:
            from huggingface_hub import hf_hub_download
            return json.loads(Path(hf_hub_download(c, rel, repo_type="dataset")).read_text())
        except Exception as exc:
            _hub_refused(c, exc)
            continue
    return None


def dataset_start_pose(s: Settings, train_cfg: dict, order) -> tuple[dict, str] | None:
    """The median pose the training episodes started from."""
    import glob
    ds = train_cfg.get("dataset") or {}
    files = []
    for c in (s.dataset, ds.get("root"), ds.get("repo_id")):
        if not c:
            continue
        p = Path(c).expanduser()
        if p.exists():
            files = sorted(glob.glob(str(p / "data" / "**" / "*.parquet"), recursive=True))
        elif not str(c).startswith("local/") and str(c).count("/") == 1:
            try:
                from huggingface_hub import hf_hub_download, list_repo_files
                names = sorted(f for f in list_repo_files(c, repo_type="dataset")
                               if f.startswith("data/") and f.endswith(".parquet"))
                files = [hf_hub_download(c, f, repo_type="dataset") for f in names[:4]]
            except Exception as exc:
                _hub_refused(c, exc)
                files = []
        if files:
            break
    if not files:
        return None
    try:
        import pandas as pd
        starts = []
        for f in files[:4]:
            df = pd.read_parquet(f, columns=["frame_index", "observation.state"])
            starts += [np.asarray(v, dtype=float) for v in
                       df.loc[df["frame_index"] == 0, "observation.state"]]
    except Exception as exc:
        print(f"  home: could not read the dataset's episodes ({exc.__class__.__name__})")
        return None
    if not starts:
        return None
    st = np.stack(starts)
    med, spread = np.median(st, axis=0), np.percentile(np.abs(st - np.median(st, 0)), 90, 0)
    pose = {j: float(med[i]) for i, j in enumerate(order)}
    return pose, (f"dataset: median start of {len(starts)} episodes, "
                  f"90% within +-{spread.max():.0f}")


def parse_home(spec: str) -> dict | None:
    """'name=value,...' or 6 comma values in SO-101 order."""
    try:
        if "=" in spec:
            pose = {k.strip().removesuffix(".pos"): float(v)
                    for k, v in (x.split("=", 1) for x in spec.split(","))}
        else:
            pose = dict(zip(LEROBOT_ORDER, (float(x) for x in spec.split(","))))
    except ValueError:
        raise SystemExit(f"--home {spec!r}: use 'dataset', 'current', 6 numbers in "
                         f"SO-101 order, or name=value pairs") from None
    if set(pose) != set(JOINTS):
        raise SystemExit(f"--home needs all 6 joints {list(LEROBOT_ORDER)}, got {list(pose)}")
    return pose


def load_config(ckpt: Path):
    """Read config.json, ignoring fields this lerobot does not know."""
    from lerobot.configs.policies import PreTrainedConfig
    try:
        return PreTrainedConfig.from_pretrained(str(ckpt))
    except Exception as exc:
        import dataclasses

        import draccus
        import lerobot.policies  # noqa: F401 -- registers the policy types
        raw = json.loads((ckpt / "config.json").read_text())
        try:
            cls = PreTrainedConfig.get_choice_class(raw.get("type"))
        except Exception:
            raise SystemExit(f"this lerobot does not know policy type "
                             f"{raw.get('type')!r}. Upgrade lerobot.") from exc
        known = {f.name for f in dataclasses.fields(cls)}
        extra = sorted(k for k in raw if k not in known and k != "type")
        print(f"  config: ignoring fields this lerobot does not know: {extra}\n"
              f"          (install the lerobot version that trained it, to be safe)")
        return draccus.decode(cls, {k: v for k, v in raw.items() if k in known})


def pick_device(s: Settings):
    """Pick cuda, mps or cpu and print what was found."""
    import torch
    dev = s.device or ("cuda" if torch.cuda.is_available()
                       else "mps" if torch.backends.mps.is_available() else "cpu")
    if dev.startswith("cuda"):
        if not torch.cuda.is_available():
            raise SystemExit(f"--device {dev}, but this torch has no CUDA "
                             f"(torch {torch.__version__}). Install a CUDA build.")
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        torch.backends.cudnn.benchmark = True
        i = torch.device(dev).index or 0
        prop = torch.cuda.get_device_properties(i)
        jetson = Path("/etc/nv_tegra_release").exists()
        what = (f"{prop.name}, sm_{prop.major}{prop.minor}, "
                f"{prop.total_memory / 2**30:.1f} GB" + (" shared (Jetson)" if jetson else ""))
        if not torch.cuda.is_bf16_supported():
            what += ", no native bf16 (emulated: slower but works)"
    elif dev == "mps":
        if not torch.backends.mps.is_available():
            raise SystemExit("--device mps, but MPS is unavailable (needs Apple silicon "
                             "and a torch build with MPS).")
        import platform
        what = f"Apple GPU via MPS, macOS {platform.mac_ver()[0]}"
    else:
        what = f"CPU, {os.cpu_count()} threads -- expect about a minute per chunk"
    print(f"  device  {dev}: {what} | torch {torch.__version__}")
    return dev


def load_policy(s: Settings):
    """Load the checkpoint and return predict_chunk(images, state)."""
    import torch
    from lerobot.policies import get_policy_class, make_pre_post_processors
    from lerobot.policies.utils import prepare_observation_for_inference

    ckpt = resolve_checkpoint(s.policy)
    train_cfg = read_train_config(ckpt)
    info = dataset_file(s, train_cfg, "meta/info.json")
    stats = dataset_file(s, train_cfg, "meta/stats.json")

    cfg = load_config(ckpt)
    if cfg.type != "smolvla":
        raise SystemExit(f"{ckpt}\n  is a {cfg.type!r} checkpoint; this leader is for "
                         f"SmolVLA only.")
    device = pick_device(s)
    cfg.device = device
    if s.num_steps:
        cfg.num_steps = s.num_steps

    # make_policy would need the dataset; from_pretrained does not.
    policy = get_policy_class(cfg.type).from_pretrained(str(ckpt), config=cfg)
    policy.to(device).eval()
    if s.fp32:
        import torch as _t
        policy.to(_t.float32)
    policy.reset()

    # Loading is not strict, so check that the trained weights really landed.
    from safetensors import safe_open
    params = dict(policy.named_parameters())
    with safe_open(ckpt / "model.safetensors", framework="pt") as f:
        probe = next((k for k in sorted(f.keys(), key=len)
                      if k in params and k.endswith(".weight")), None)
        if probe is None:
            print("  WARNING: no checkpoint tensor matched a model parameter -- "
                  "the weights may not have loaded")
        else:
            want = f.get_tensor(probe).float()
            got = params[probe].detach().float().cpu()
            if got.shape != want.shape or not torch.allclose(got, want, atol=1e-3):
                raise SystemExit(f"the weights did not load ({probe}). Install the "
                                 f"lerobot version that trained this checkpoint.")

    try:
        pre, post = make_pre_post_processors(
            policy_cfg=cfg, pretrained_path=str(ckpt),
            preprocessor_overrides={"device_processor": {"device": device}},
            postprocessor_overrides={"device_processor": {"device": "cpu"}})
    except Exception as exc:
        if "migration" not in str(exc).lower():
            raise
        raise SystemExit(f"{ckpt}\n  is a pre-0.6 checkpoint. Convert it once:\n\n"
                         f"    python -m lerobot.processor.migrate_policy_normalization "
                         f"--pretrained-path {ckpt}\n\n  then use the `_migrated` "
                         f"folder.") from None

    width = cfg.output_features["action"].shape[0]
    if width != len(JOINTS):
        raise SystemExit(f"the checkpoint outputs {width} actions; this robot has "
                         f"{len(JOINTS)} joints. It was trained on another robot.")
    if s.joint_order:
        act_order = st_order = tuple(s.joint_order)
        order_src = "--joint-order"
    elif info and info["features"].get("action", {}).get("names"):
        feats = info["features"]
        act_order = tuple(n.removesuffix(".pos") for n in feats["action"]["names"])
        st_order = tuple(n.removesuffix(".pos") for n in
                         (feats.get("observation.state", {}).get("names")
                          or feats["action"]["names"]))
        order_src = "dataset info.json"
    else:
        act_order = st_order = LEROBOT_ORDER
        order_src = "LeRobot default -- no dataset found, pass --dataset to be sure"
    for order in (act_order, st_order):
        if sorted(order) != sorted(JOINTS):
            raise SystemExit(f"joint names {list(order)} are not this robot's "
                             f"{list(JOINTS)}. Pass --joint-order.")

    # The follower streams normalized units. Show the dataset's range so a
    # dataset recorded in degrees is easy to spot.
    if stats and "action" in stats and "max" in stats["action"]:
        lo = np.array(stats["action"]["min"], dtype=float)
        hi = np.array(stats["action"]["max"], dtype=float)
        rng = "  ".join(f"{j}[{lo[i]:+.0f},{hi[i]:+.0f}]" for i, j in enumerate(act_order))
        print(f"  range   {rng}   (dataset stats)")
        arm = [i for i, j in enumerate(act_order) if j != "gripper"]
        if max(np.abs(lo[arm]).max(), np.abs(hi[arm]).max()) > 150:
            print("  WARNING: arm joints reach beyond +-150 in the training data -- that "
                  "looks like DEGREES,\n           but the follower streams normalized "
                  "units. If the dataset was recorded with\n           use_degrees=True, "
                  "the arm will be driven to wrong poses.")

    if s.policy_hz:
        hz, hz_src = s.policy_hz, "--policy-hz"
    elif info and info.get("fps"):
        hz, hz_src = float(info["fps"]), "dataset info.json"
    else:
        hz, hz_src = 30.0, "LeRobot default -- no dataset found, pass --policy-hz"

    # Training with --rename_map records which camera fed which slot.
    slots = sorted(k.removeprefix("observation.images.") for k in cfg.image_features
                   if "empty_camera" not in k)
    cam_map, cam_src = {}, "checkpoint names"
    for src, dst in (train_cfg.get("rename_map") or {}).items():
        if dst.startswith("observation.images.") and src.startswith("observation.images."):
            cam_map[dst.removeprefix("observation.images.")] = \
                src.removeprefix("observation.images.")
            cam_src = "train_config rename_map"
    if s.camera_map:
        cam_map, cam_src = dict(s.camera_map), "--camera-map"
    cam_map = {slot: cam_map.get(slot, slot) for slot in slots}

    print(f"  smolvla | {ckpt}")
    for slot in slots:
        print(f"  camera  {slot:<12} <- follower '{cam_map[slot]}'   ({cam_src})")
    print(f"  joints  {list(act_order)}   ({order_src})")
    print(f"  rate    {hz:g} Hz, chunk {cfg.chunk_size} = {cfg.chunk_size / hz:.1f}s   "
          f"({hz_src})")
    print(f"  dtype   {'float32 (--fp32)' if s.fp32 else 'checkpoint default (bf16 + fp32)'}")
    print(f"  steps   {cfg.num_steps} denoising steps"
          + ("" if s.num_steps else "   (--num-steps 5 for ~2x speed on small GPUs)"))
    print(f"  task    {s.task!r}")

    fp32 = [s.fp32]

    def infer(batch):
        with torch.inference_mode():
            return post(policy.predict_action_chunk(pre(batch)))

    def predict_chunk(images, state):
        obs = {}
        for slot in slots:
            frame = images.get(cam_map[slot])
            if frame is None:
                return []
            obs[f"observation.images.{slot}"] = frame
        obs["observation.state"] = np.array([state.get(j, 0.0) for j in st_order],
                                            dtype=np.float32)
        batch = prepare_observation_for_inference(
            obs, torch.device(device), s.task, "so101_follower")
        try:
            acts = infer(batch)
        except (RuntimeError, TypeError) as exc:
            # Some devices lack a bf16 kernel. Fall back to fp32 once.
            if fp32[0] or "bfloat16" not in str(exc).lower().replace("_", ""):
                raise
            fp32[0] = True
            print(f"  {device} lacks a bf16 kernel ({str(exc).splitlines()[0][:80]});"
                  f" switching the model to fp32", flush=True)
            policy.to(torch.float32)
            acts = infer(batch)
        acts = acts.reshape(-1, width).float().cpu().numpy()
        return [{j: float(v) for j, v in zip(act_order, row)} for row in acts]

    mode = s.home.strip().lower()
    if mode == "current":
        home, home_src = None, "current pose (no move)"
    elif mode == "dataset":
        found = dataset_start_pose(s, train_cfg, st_order)
        home, home_src = found if found else (None, "current pose -- no dataset episodes "
                                                    "found, pass --dataset or --home")
    else:
        home, home_src = parse_home(s.home), "--home"
    print("  home    " + ("  ".join(f"{j}={home[j]:+.1f}" for j in LEROBOT_ORDER)
                          if home else "-") + f"   ({home_src})")

    predict_chunk.home = home
    predict_chunk.labels = [cam_map[sl] for sl in slots]
    predict_chunk.num_steps = cfg.num_steps
    predict_chunk.hz = hz
    return predict_chunk


# ── Leader ─────────────────────────────────────────────────────────────────

def make_leader(s: Settings):
    from zeroruntime.teleops import Leader, single_group_descriptor
    from zeroruntime.teleops.protocol import Units

    class PolicyLeader(Leader):
        """A Leader whose joint targets come from the model."""

        def __init__(self, **kw) -> None:
            self.robot_id = "smolvla"
            self.action = {j: 0.0 for j in JOINTS}
            self._lock = threading.Lock()
            super().__init__(**kw)

        def descriptor(self):
            return single_group_descriptor(self.robot_id, "policy", JOINTS,
                                           control_hz=s.fps, units=Units.NORMALIZED)

        def read_joints(self):
            with self._lock:
                return dict(self.action)

        def set_action(self, joints) -> None:
            with self._lock:
                self.action.update(joints)

    return PolicyLeader(meeting_id=s.meeting_id, token=s.token, publish_hz=s.fps,
                        max_misalignment=None, sync_buffer_ms=s.sync_buffer_ms)


def _rgb(frame):
    """I420 frame from the wire to RGB."""
    import cv2
    return cv2.cvtColor(frame.array, cv2.COLOR_YUV2RGB_I420)


def infer_forever(leader, predict_chunk, s: Settings, stop, ready) -> None:
    """Play the current chunk while the next one is computed."""
    period = 1.0 / predict_chunk.hz
    limit = {j: v * period for j, v in s.max_speed.items()}
    queue, lock = [], threading.Lock()
    busy = threading.Event()
    lat = [None]
    chunk_len = [None]
    clipped, starved = [0], [0]
    warned = [0.0]
    seen, last_wait = None, 0.0

    def run(images, joints, t_obs):
        try:
            acts = predict_chunk(images, joints)
            if not acts:
                return
            dt = time.monotonic() - t_obs
            lat[0] = dt if lat[0] is None else 0.7 * lat[0] + 0.3 * dt
            chunk_len[0] = len(acts)
            chunk_s = len(acts) * period
            new = acts[int(round(dt / period)):]
            with lock:
                old = queue[:]
                n = min(s.blend_steps, len(old), len(new))
                for k in range(n):
                    w = (k + 1) / (n + 1)
                    new[k] = {j: (1 - w) * old[k][j] + w * new[k][j] for j in new[k]}
                if not ready.is_set():
                    # Fade the first chunk in from the held pose.
                    base = leader.read_joints()
                    n = min(int(round(s.ramp_s / period)), len(new))
                    for k in range(n):
                        t = (k + 1) / (n + 1)
                        w = t * t * (3 - 2 * t)
                        new[k] = {j: (1 - w) * base[j] + w * v for j, v in new[k].items()}
                if new:
                    queue[:] = new
            thr = prefetch_threshold(s, chunk_s, lat[0], period)
            if s.verbose or not ready.is_set():
                print(f"  chunk {dt * 1e3:5.0f} ms  skipped {len(acts) - len(new):2d}  "
                      f"queue {len(new):2d}  blended {n:2d}  clipped {clipped[0]:2d}  "
                      f"paused {starved[0] * period:4.1f}s  next at {thr:.1f}s left",
                      flush=True)
            now = time.monotonic()
            if ready.is_set() and now - warned[0] > 30:
                if lat[0] > 0.8 * chunk_s:
                    warned[0] = now
                    print(f"  WARNING: inference {lat[0]:.1f}s is close to a whole chunk "
                          f"({chunk_s:.1f}s): the arm will keep pausing. Use --num-steps "
                          f"3-5, or a faster GPU.", flush=True)
                elif starved[0] * period > 0.3:
                    warned[0] = now
                    print(f"  WARNING: the arm waited {starved[0] * period:.1f}s for this "
                          f"chunk. Raise --prefetch-s (now {thr:.1f}s) or use --num-steps.",
                          flush=True)
            clipped[0] = starved[0] = 0
        except Exception:
            traceback.print_exc()
        finally:
            busy.clear()

    due = time.monotonic()
    while not stop.is_set():
        with lock:
            left = len(queue)
        due_now = (chunk_len[0] is None or left * period
                   <= prefetch_threshold(s, chunk_len[0] * period, lat[0], period))
        if not busy.is_set() and due_now:
            obs = leader.observation()
            try:
                labels = set(obs.images)
                if labels != seen and labels:
                    seen = labels
                    missing = [c for c in predict_chunk.labels if c not in labels]
                    print(f"  follower cameras {sorted(labels)}"
                          + (f"  MISSING {missing}: holding. Fix --camera-map or the "
                             f"follower's camera labels" if missing else ""), flush=True)
                if labels >= set(predict_chunk.labels):
                    images = {k: _rgb(obs.images[k]) for k in predict_chunk.labels}
                    joints = dict(obs.joints)
                else:
                    images = None
            finally:
                for f in obs.images.values():
                    f.release()
            if images:
                busy.set()
                threading.Thread(target=run, args=(images, joints, time.monotonic()),
                                 name="chunk", daemon=True).start()
            elif time.monotonic() - last_wait > 5:
                last_wait = time.monotonic()
                print("  waiting for video...", flush=True)

        with lock:
            step = queue.pop(0) if queue else None
        if step:
            safe, cur = {}, leader.read_joints()
            for j, v in step.items():
                d = v - cur.get(j, v)
                lim = limit.get(j)
                if lim is not None and abs(d) > lim:
                    d, clipped[0] = (lim if d > 0 else -lim), clipped[0] + 1
                safe[j] = cur.get(j, v) + d
            leader.set_action(safe)
            ready.set()
        elif ready.is_set():
            starved[0] += 1

        due += period
        delay = due - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        else:
            due = time.monotonic()


def prefetch_threshold(s: Settings, chunk_s: float, latency: float, period: float) -> float:
    """Seconds of actions left when the next inference should start."""
    base = s.prefetch_s if s.prefetch_s is not None else chunk_s / 2
    return min(max(base, latency + 0.5), chunk_s - period)


# ── Modes ──────────────────────────────────────────────────────────────────

def check(predict_chunk, s: Settings) -> None:
    """Time inference on grey frames, no robot needed."""
    grey = np.full((480, 640, 3), 128, dtype=np.uint8)
    images = {lbl: grey for lbl in predict_chunk.labels}
    state = {j: 0.0 for j in JOINTS}
    times = []
    for i in range(4):
        t = time.monotonic()
        acts = predict_chunk(images, state)
        times.append(time.monotonic() - t)
        assert acts, "empty chunk"
        assert all(np.isfinite(list(a.values())).all() for a in acts), "non-finite action"
        print(f"  chunk {i}  {times[-1] * 1e3:7.0f} ms" + ("   (warm-up)" if i == 0 else "")
              + "   first: " + "  ".join(f"{j}={acts[0][j]:+.1f}" for j in JOINTS))

    took = float(np.median(times[1:]))
    period = 1.0 / predict_chunk.hz
    chunk_s = len(acts) * period
    thr = prefetch_threshold(s, chunk_s, took, period)
    print(f"\nok. inference {took:.2f}s per chunk of {len(acts)} actions ({chunk_s:.1f}s)")
    print(f"  prefetch  next inference at {thr:.1f}s left "
          f"({'auto' if s.prefetch_s is None else '--prefetch-s'}) -> re-plans about "
          f"every {max(chunk_s - thr, took):.1f}s, plans {took:.1f}s old when they land")

    steps = predict_chunk.num_steps
    if took > 0.8 * chunk_s:
        print("  verdict   TOO SLOW: the arm will pause between chunks.")
        if steps and steps > 3:
            print(f"            try --num-steps {max(3, steps // 2)}, or a faster GPU.")
        else:
            print("            use a faster GPU (or cuda/mps instead of cpu).")
    elif took > FRESH_S:
        print(f"  verdict   STALE: plans are {took:.1f}s old when they run. Above ~{FRESH_S}s "
              f"the arm tends to\n            hover over the object instead of grasping.")
        if steps and steps > 3:
            print(f"            try --num-steps {max(3, steps // 2)}"
                  + ("" if s.fp32 else ", and --fp32 (compare)") + ", then re-check.")
        else:
            print("            fewer steps won't help much: the vision encoder dominates."
                  + ("" if s.fp32 else " Try --fp32;") + " else use a faster GPU.")
    else:
        print("  verdict   fast enough. No changes needed.")
    if s.prefetch_s is not None and s.prefetch_s < took + 0.5:
        print(f"  note      --prefetch-s {s.prefetch_s} is below inference + 0.5s; "
              f"{took + 0.5:.1f}s is used instead.")


def warm_up(predict_chunk) -> None:
    """Run one inference first so the first real chunk is not slow."""
    grey = np.full((480, 640, 3), 128, dtype=np.uint8)
    t = time.monotonic()
    predict_chunk({lbl: grey for lbl in predict_chunk.labels}, {j: 0.0 for j in JOINTS})
    print(f"  warm-up {time.monotonic() - t:.1f}s", flush=True)


def drive(predict_chunk, s: Settings) -> None:
    warm_up(predict_chunk)
    leader = make_leader(s)

    @leader.on_ready
    def _(desc):
        print(f"robot online: {desc.robot_id}, schema {desc.schema_hash}")

    leader.start()
    stop, ready = threading.Event(), threading.Event()
    worker = None
    try:
        if not leader.claim_control(timeout_s=10):
            raise SystemExit(f"no control: no follower answered in {s.meeting_id}\n"
                             f"  start follower.py first, with the same room id. If a "
                             f"previous leader crashed, restart the follower.")
        print(f"control granted, schema {leader.schema}")

        # Hold the current pose until there is something better to send.
        t0 = time.monotonic()
        while True:
            obs = leader.observation()
            joints = dict(obs.joints)
            for f in obs.images.values():
                f.release()
            if set(JOINTS) <= set(joints):
                break
            if time.monotonic() - t0 > 15:
                raise SystemExit("no joint state from the follower in 15 s")
            time.sleep(0.05)
        start = {j: joints[j] for j in JOINTS}
        leader.set_action(start)
        print("start   " + "  ".join(f"{j}={start[j]:+.1f}" for j in LEROBOT_ORDER))

        # Move smoothly to the start pose before the policy takes over.
        home = predict_chunk.home or start
        dist = max(abs(home[j] - start[j]) for j in JOINTS)
        dur = max(s.home_min_s, dist / s.home_speed) if dist > 0.5 else 0.0

        def start_policy():
            nonlocal worker
            worker = threading.Thread(target=infer_forever,
                                      args=(leader, predict_chunk, s, stop, ready),
                                      name="inference", daemon=True)
            worker.start()

        # Video only flows while the deadman is held.
        leader.hold_deadman(True)
        if dur:
            print(f"homing: {dist:.0f} units on the farthest joint, {dur:.1f}s "
                  f"(keep the workspace clear)", flush=True)
        phase, t_phase, t_arm, driving = ("home" if dur else "settle"), time.monotonic(), 0.0, False
        for i in leader.ticks(hz=s.fps):
            now = time.monotonic()
            if phase == "home":
                tau = min(1.0, (now - t_phase) / dur)
                w = tau ** 3 * (10 - 15 * tau + 6 * tau * tau)
                leader.set_action({j: start[j] + w * (home[j] - start[j]) for j in JOINTS})
                if tau >= 1.0:
                    phase, t_phase = "settle", now
            elif phase == "settle":
                if now - t_phase >= s.home_settle_s:
                    obs = leader.observation()
                    got = dict(obs.joints)
                    for f in obs.images.values():
                        f.release()
                    err = max((abs(got[j] - home[j]) for j in JOINTS if j in got), default=0.0)
                    print(f"at start pose (max error {err:.1f})"
                          + ("  -- WARNING: arm did not reach it; check the follower's "
                             "slew / obstacles" if err > 10 else ""), flush=True)
                    print("waiting for the first chunk (the arm holds still)...", flush=True)
                    start_policy()
                    phase, t_arm = "policy", now
            elif not driving:
                if ready.is_set():
                    driving = True
                    print("armed, the policy is driving. ctrl-c once to stop.", flush=True)
                elif now - t_arm > s.first_chunk_timeout_s:
                    raise SystemExit(f"no chunk in {s.first_chunk_timeout_s:.0f}s -- "
                                     f"see the camera lines above")
            if i % (s.fps * 5) == 0:
                print(f"tick {i:6d}  sent={leader.commands_sent}  "
                      f"in flight={leader.seq - leader.applied_seq}  "
                      f"{leader.robot_safe_state}", flush=True)
            if worker is not None and not worker.is_alive():
                raise SystemExit("the inference thread died -- see above")
    except KeyboardInterrupt:
        pass
    finally:
        import signal
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        print("stopping: releasing the deadman, leaving the room...", flush=True)
        stop.set()
        try:
            # The follower holds the arm once commands stop.
            leader.hold_deadman(False)
        finally:
            if worker is not None:
                worker.join(timeout=2.0)
            leader.stop()


def main() -> None:
    s = parse_args()
    predict_chunk = load_policy(s)
    if s.check:
        return check(predict_chunk, s)
    drive(predict_chunk, s)


if __name__ == "__main__":
    main()