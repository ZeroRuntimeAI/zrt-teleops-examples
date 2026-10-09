# so101/yolo: Stage 1 (YOLO scene state)

Runs on the Jetson in `~/zrt-teleops-examples/so101/yolo`, with the examples venv. It opens **no
camera and no arm**. `capture.py` joins the teleop room as a watch-only peer and gets the
follower's three video tracks plus `gripper.pos` from the session, so your teleop runs exactly
as before. Background: `plan.md`.

## a. Sync

The code lives on branch `feat/yolo-pi`. Commit and push on the Mac, then on the Jetson:

```bash
cd ~/zrt-teleops-examples && git fetch && git checkout feat/yolo-pi && git pull
```

`data/`, `runs/` and model files are gitignored. They stay on the Jetson.

## b. One-time install (Jetson)

```bash
cd ~/zrt-teleops-examples && source venv/bin/activate
pip install --no-deps ultralytics ultralytics-thop ultralytics-platform
pip install matplotlib polars psutil nvidia-ml-py
python -c "import cv2, torch, ultralytics; print(cv2.__version__, torch.cuda.is_available(), ultralytics.__version__)"
```

Use `--no-deps`. A plain `pip install ultralytics` adds `opencv-python` 5.0 next to the venv's
`opencv-python-headless` 4.13, and the two overwrite each other's `cv2`. The check should print
`4.13.0 True <version>`.

## c. Start the teleop, then the watcher

```bash
# terminal 1 (Jetson)
cd ~/zrt-teleops-examples/so101 && source ../venv/bin/activate && python follower.py
# leader side: as usual
# terminal 2 (Jetson)
cd ~/zrt-teleops-examples/so101/yolo && source ../../venv/bin/activate && python capture.py
```

The status line shows `grip <value>`. Note it with the gripper fully open, closed on nothing,
and closed on the cube. These values give the optional `GRIP_HOLD_BAND` in `config.py`.

Camera names: `config.CAMERAS` maps `top`/`wrist`/`side` to follower.py's `cam0`/`cam1`/`cam2`,
which are ordered by USB port. After your first saved session, open one image per camera and
check the mapping. If you move a camera cable to another USB port, check it again.

## d. Capture sessions

```bash
python capture.py --scene CUBE_ON_TABLE --tag center_bright
python capture.py --scene CUBE_IN_GRIPPER --tag lifted
python capture.py --scene CUBE_IN_BOX --tag released
python capture.py --scene NO_CUBE --tag empty
```

**Rule: never change the scene mid-session.** One session = one true state. Ctrl-C, then start a
new session with the new `--scene`. Vary cube position, arm pose and lighting between sessions.
Aim for about 100 frames per state per camera, and at least 4 sessions per state.

Hard negatives (plan.md 1.3), labelled with their TRUE state:

| Scene | `--scene` | `--tag` |
|---|---|---|
| Fingers open around the cube, just before the grasp | `CUBE_ON_TABLE` | `pre_grasp` |
| Gripper closed on nothing, cube on the table | `CUBE_ON_TABLE` | `closed_empty` |
| Gripper closed on nothing, no cube anywhere | `NO_CUBE` | `closed_empty` |
| Cube held above the box | `CUBE_IN_GRIPPER` | `above_box` |
| Cube resting on the box rim | `CUBE_ON_TABLE` | `on_rim` |
| Cube on the table, hidden from `top` by the arm | `CUBE_ON_TABLE` | `occluded_top` |
| Cube in the box, arm hovering over it (gripper open) | `CUBE_IN_BOX` | `arm_hover` |
| Empty box and table (+ distractors) | `NO_CUBE` | `empty_distractors` |

## e. Label

Copy `data/yolo_raw/` to your labelling tool (CVAT / Label Studio / Roboflow). Label boxes
`cube` and `box` (objects, not states), with class order `0=cube`, `1=box`. Export in **YOLO**
format and put every `.txt` flat in `data/labels/` on the Jetson. Tool-added prefixes or suffixes
on the file names are fine. Export empty `.txt` files for empty scenes too: they are valid
background images.

## f. Split by session, set the wrist ROI

```bash
python split.py              # every 4th session per state -> val; --val-every N to change
```

This builds `data/yolo/` (symlinks), `data/yolo/data.yaml` and `data/yolo/val_sessions.txt`, and
prints `suggested WRIST_HOLD_ROI = (...)`. Copy that into `config.py`. If it warns that
CUBE_ON_TABLE wrist cubes fall inside the ROI, also set `GRIP_HOLD_BAND` from step c.

## g. Train (Jetson, with the teleop stopped, since they share 8 GB)

```bash
yolo detect train model=yolo11n.pt data=data/yolo/data.yaml imgsz=640 epochs=100 batch=8
```

## h. Evaluate state on held-out sessions

```bash
python eval_state.py --model runs/detect/train/weights/best.pt          # val sessions
python eval_state.py --model runs/detect/train/weights/best.pt --all    # every session (optimistic)
```

## i. Live check (teleop running)

```bash
python capture.py --model runs/detect/train/weights/best.pt
```

Move the cube table → gripper → box. The `stable` state must follow.

## j. Stage 1 done when

- [ ] Per-state accuracy on held-out sessions is >= 98% after debounce (`DEBOUNCED` table).
- [ ] **Zero** `FALSE CUBE_IN_BOX`.
- [ ] The live check (i) follows the cube through the whole task.

Self-checks (no hardware): `python state.py`, `python split.py --selftest`, `python eval_state.py --selftest`.
