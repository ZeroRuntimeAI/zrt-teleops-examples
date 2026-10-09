# pi_yolo — Pick cube, place in box (YOLO supervisor + pi0.5)

**Goal:** an SO-101 arm picks up a cube and places it in a box. YOLO, combined with the
gripper position reading, works out the scene state. A small supervisor uses that state to
pick which pi0.5 policy runs, retries on failure and stops when the task is done.

---

## 0. Setup and roles

| Machine | What runs there |
|---|---|
| **Mac** | Writing code. Optionally YOLO training (MPS). Copies code to the Jetson. |
| **Jetson Orin Nano 8GB** | SO-101 follower and leader, 3 cameras, LeRobot recording, YOLO (TensorRT), supervisor and LeRobot `RobotClient` |
| **Cloud L4 (24GB)** | pi0.5 fine-tuning, plus the LeRobot `PolicyServer` that runs pi0.5 during inference |

The Orin Nano can't run pi0.5: the weights alone are about 7GB in bf16. pi0.5 therefore runs
on the L4 through LeRobot **async inference** (gRPC). The Jetson sends camera frames and
receives action chunks.

```
             Jetson Orin Nano                                Cloud L4
 ┌──────────────────────────────────────────┐      ┌────────────────────────┐
 │ cams(top, side, wrist)  + SO-101 state  │      │                        │
 │        │                                 │      │                        │
 │        ├──► YOLO (TensorRT) ─┐           │      │                        │
 │        │                     ▼           │      │                        │
 │        │   gripper.pos ──► state machine │      │                        │
 │        │                     │ task/stop │      │                        │
 │        ▼                     ▼           │ gRPC │                        │
 │   RobotClient (subclassed) ──── obs ────────────►  PolicyServer (pi0.5)  │
 │        ▲                                 │ over │                        │
 │        └──────────── action chunks ◄──────────────                       │
 │   SO-101 follower                        │ SSH  │                        │
 └──────────────────────────────────────────┘tunnel└────────────────────────┘
```

**Copying code from the Mac to the Jetson.** `rsync` only sends changed files. `scp -r` works too.

```bash
rsync -av --exclude 'data/' --exclude 'runs/' ~/pi_yolo/ <user>@<jetson-ip>:~/pi_yolo/
ssh <user>@<jetson-ip>
```

**Rules that apply to every stage**
- Choose the camera names now and never change them. Chosen: `top`, `side`, `wrist`.
  pi0.5 checkpoints are tied to these keys.
- Use the same camera index or path, resolution and fps for YOLO data, policy recording and
  deployment. Record on the Jetson so the setup matches deployment.
- Pin one LeRobot version (git commit) on the Jetson and on the cloud box.
  Record it here: `LEROBOT_COMMIT = ____`.

---

## Stage 1: YOLO scene detection (no policy)

**Goal:** prove that YOLO (plus, optionally, `gripper.pos`) can reliably tell the scene states
apart. You move the arm with your normal zrt teleop (`so101/follower.py` + leader). The Stage 1
code opens no camera and no arm: `capture.py` joins the teleop room as a **watch-only peer**
(an SDK `Leader` that never claims control or holds the deadman, so it can't send commands). It
reads the follower's 3 video tracks and joints with `peek_synced()`, the SDK's call for
watchers. The joints are interpolated to each frame's capture time.

### 1.1 Jetson bring-up
- [x] JetPack: L4T R39.2.1, Python 3.12. The examples venv (`~/zrt-teleops-examples/venv`) has
      zeroruntime-teleops 0.1.2, lerobot 0.6.1 and torch 2.11 with CUDA.
- [ ] Install `ultralytics` into that venv with `--no-deps` (README step b), because the venv
      uses `opencv-python-headless`.
- [x] Cameras: follower.py publishes `cam0` = top (USB 2.1), `cam1` = wrist (USB 2.3, Xitech),
      `cam2` = side (USB 2.4), ordered by USB port. Mapped in `config.CAMERAS`.
- [ ] First run: the watcher receives all 3 tracks and the gripper reading while you teleop.

### 1.2 Scene states to detect

| State | Meaning |
|---|---|
| `CUBE_ON_TABLE` | Cube is in the workspace and not held |
| `CUBE_IN_GRIPPER` | Gripper is holding the cube |
| `CUBE_IN_BOX` | Cube is inside the box and the gripper is open or released |
| `NO_CUBE` | Cube isn't visible anywhere (removed, or hidden by the arm) |

### 1.3 Capture images
`capture.py` saves the 3 session frames plus `gripper.pos` every ~0.5 s under
`data/yolo_raw/<scene>/<session>/`. The scene name you pass on the command
line becomes a free ground-truth label for the evaluation in 1.6.

For each state, vary the cube position, arm pose and lighting. Include these **hard negatives**:
- [ ] Fingers open around the cube just before the grasp, which looks like holding in the wrist cam
- [ ] Gripper closed with nothing in it
- [ ] Cube held *above* the box, which in 2D looks like `IN_BOX`
- [ ] Cube resting on the box rim
- [ ] Cube on the table but hidden from `top` by the arm
- [ ] Cube in the box with the arm still hovering over it
- [ ] Empty box and empty table, plus distractor objects if any will be present

Starting target: about 100 frames per state per camera. Add more where evaluation fails.

### 1.4 Label boxes
- Classes: **`cube`** and **`box`**. Label objects, not states; the state is computed in 1.6.
- Labelling tool: `____` (CVAT, Label Studio or Roboflow).
- Keep the held-out split **by capture session**, not by random frames. Neighbouring frames are
  almost identical and would inflate the accuracy numbers.

### 1.5 Train and deploy YOLO
- [ ] Train `yolo11n` on the Jetson (`best.pt` runs on CUDA). 640 px to start.
- [ ] Measure inference speed on the Jetson with 3 cameras: target **≥10 Hz across all cameras**.
- [ ] Only if that's too slow: TensorRT export (`format=engine half=True batch=3`). The venv
      has no `tensorrt` module yet.

### 1.6 State rules
- [ ] `state.py`: a pure function from (detections per camera, optional `gripper.pos`) to a state.
      All boxes are normalized 0..1, so a change in stream resolution doesn't matter.
  - `holding` = the wrist-cam cube centre lies inside `WRIST_HOLD_ROI`. The wrist cam is rigid
    on the gripper, so a held cube always lands in the same spot. `python split.py` suggests
    the ROI from your labelled `CUBE_IN_GRIPPER` wrist frames, and warns if `CUBE_ON_TABLE`
    frames (pre-grasp) fall inside it.
  - Open fingers around the cube (pre-grasp) can look like holding. If `split.py` or eval shows
    this, set `GRIP_HOLD_BAND` so that holding also requires `gripper.pos` in the "closed on
    cube" band.
  - `in_box` = cube centre inside the box on the fixed cams, with no fixed cam seeing the
    cube outside, **and** not `holding`
  - Order: `IN_BOX` → `IN_GRIPPER` → `ON_TABLE` → `NO_CUBE`
- [ ] Debounce: switch state only after `DEBOUNCE_N` consecutive agreeing frames.
- [ ] `eval_state.py`: run `state.py` on the held-out frames and print a confusion matrix
      against the scene labels.

**Stage 1 done when**
- [ ] Per-state accuracy on the held-out sessions is ≥ 98% after debounce.
- [ ] There are **no** false `CUBE_IN_BOX` results. A false "done" is the worst possible error.
- [ ] With your teleop running, `capture.py --model` shows the correct live state as you move the cube through the task.

---

## Stage 2: Train the policies (pi0.5)

**Policy A, pick:** `"pick up the cube"`. The episode starts with the arm at home or in a
varied pose and the cube on the table. It ends with the cube lifted a few cm.
**Policy B, place:** `"place the cube in the box"`. The episode starts with the cube already
in the gripper, from varied poses, including exactly where Policy A ends. It ends with the cube
released in the box and the arm pulled back.

### 2.1 Cloud L4 bring-up
- [ ] Provider: `____`. Install the pinned LeRobot with `pip install -e ".[pi]"` and `".[async]"`.
- [ ] Accept the license for the gated `google/paligemma-3b-pt-224` tokenizer on the HF Hub,
      then run `hf auth login` on the cloud box.

### 2.2 Record datasets (on the Jetson, `lerobot-record`)
- [ ] Dataset A: `<hf_user>/so101_pick_cube`, `--dataset.single_task="pick up the cube"`
- [ ] Dataset B: `<hf_user>/so101_place_cube`, `--dataset.single_task="place the cube in the box"`
- For B, do the pick by teleop **during the reset period** (not recorded) and start recording
  once the cube is held. Vary the starting pose, and include starts that look like Policy A's end.
- Spread the cube positions across the whole reachable workspace. Vary the box position if it
  will move at deployment.
- Add some **recovery episodes**: regrasp after a slip, cube near the box, cube near the edge
  of the workspace. These are worth more than extra clean demos.
- Starting target: about 50 episodes each. Add episodes for the failure modes you see in 2.5.
- These videos also give you free YOLO training frames. Pull some back into Stage 1 data.

### 2.3 Train (cloud L4)
On a 24GB card, pi0.5 has to train with the VLM frozen. Full fine-tuning is sized for 80GB.

```bash
lerobot-train \
  --dataset.repo_id=<hf_user>/so101_pick_cube \
  --policy.type=pi05 \
  --policy.pretrained_path=lerobot/pi05_base \
  --policy.freeze_vision_encoder=true \
  --policy.train_expert_only=true \
  --policy.gradient_checkpointing=true \
  --policy.dtype=bfloat16 \
  --policy.device=cuda \
  --batch_size=8 \
  --steps=20000 --save_freq=2000 \
  --output_dir=./outputs/pi05_pick --job_name=pi05_pick
```
- [ ] Raise `batch_size` until just before it runs out of memory. Record the value: `____`.
- [ ] If you get `QUANTILES normalization mode requires q01 and q99`, run
      `lerobot-edit-dataset --operation.type recompute_stats`. Alternatively, pass a MEAN_STD
      `--policy.normalization_mapping`. See the LeRobot pi05 docs.
- [ ] Repeat for dataset B → `outputs/pi05_place`.
- [ ] Treat the step count as a starting guess. Test several checkpoints on the real arm rather
      than trusting the loss.

### 2.4 Async inference smoke test
- [ ] On the L4: `python -m lerobot.async_inference.policy_server --host=127.0.0.1 --port=8080`
- [ ] On the Jetson, open an SSH tunnel: `ssh -N -L 8080:127.0.0.1:8080 <user>@<cloud>`.
      **Never expose the gRPC port publicly.** It exchanges pickled data, which means anyone
      who can reach it can run code on your server.
- [ ] On the Jetson: `python -m lerobot.async_inference.robot_client --server_address=127.0.0.1:8080
      --robot.type=so101_follower ... --policy_type=pi05 --pretrained_name_or_path=<ckpt>
      --task="pick up the cube" --debug_visualize_queue_size=True`
- [ ] The action queue must never run empty. If it does, lower the fps, tune
      `actions_per_chunk` and `chunk_size_threshold`, or choose a closer cloud region.
- [ ] Record the round-trip latency: `____ ms`. Check the GPU memory per loaded policy: `____ GB`.

### 2.5 Standalone evaluation
- [ ] Policy A: 20 trials from random cube positions → `__/20`
- [ ] Policy B: 20 trials from a held cube in varied poses → `__/20`

**Stage 2 done when** both policies reach ≥ 16/20 on their own and the queue never runs dry.

---

## Stage 3: Combine YOLO and the policies

### 3.1 Supervisor = subclassed `RobotClient` (one process on the Jetson)
- Cameras can only be opened by one process. The supervisor therefore runs YOLO on the
  **same frames** the client captures in `control_loop_observation()` through
  `robot.get_observation()`, rather than opening the cameras a second time.
- In the stock client, `task` is fixed for the whole `control_loop()` call and is attached to
  every observation as `raw_observation["task"]`. Override the loop so the task comes from the
  state machine on every observation.
- On a state switch, **drop the queued actions** from the old policy. The stock client has no
  clear method; replace `action_queue` with an empty one, under the client's lock.
- Files: `state.py` (from Stage 1) and `supervisor.py` (the subclass plus the state machine).
- Add `gripper.pos` back to `classify`, since `get_observation()` returns it here. Measure it fully
  open, closed on nothing and closed on the cube, then set holding = wrist ROI **and**
  `gripper.pos` in the "closed on cube" band. This fixes the pre-grasp false holds from Stage 1.

### 3.2 Switching policies: decide before writing 3.1
The stock client loads **one policy per server handshake**. Two separate checkpoints therefore
means reconnecting or reloading on every switch, or running two servers.
- **Option 1 (recommended):** fine-tune **one** pi0.5 on datasets A and B together. Each
  dataset already carries its own task string. A switch is then just a different prompt
  string, with no reload and half the GPU memory.
- **Option 2:** keep two checkpoints. Run two `PolicyServer`s on two ports, if both fit in
  24GB per 2.4, and switch between them in the client. Measure the switching delay.
- Decision: `____`

### 3.3 State machine

| Priority | Debounced state | Action |
|---|---|---|
| 1 | `CUBE_IN_BOX` | Stop the policy, send the arm home → **DONE** |
| 2 | `CUBE_IN_GRIPPER` | Run place (B) |
| 3 | `CUBE_ON_TABLE` | Run pick (A) |
| 4 | `NO_CUBE` for < `LOST_GRACE_S` | Keep the current policy (likely just occlusion) |
| 4b | `NO_CUBE` for ≥ `LOST_GRACE_S` | Stop, go home, alert |

These guards come on top of the table:
- **Timeout:** if a policy runs for more than `POLICY_TIMEOUT_S` without the state advancing,
  go home and retry. After `MAX_RETRIES` attempts, stop and alert.
- **Network loss:** if the server disconnects or the queue stays empty for more than `NET_STALL_S`,
  hold position and stop. Don't keep replaying old actions.
- **E-stop:** a key press or Ctrl-C immediately disables torque or holds the arm.

### 3.4 Edge-case tests

| # | Scenario | Expected |
|---|---|---|
| 1 | Start with the cube already in the box | DONE, the arm never moves |
| 2 | Start with the cube on the table | pick → place → DONE |
| 3 | Start with the cube already in the gripper | place → DONE |
| 4 | Knock the cube out of the gripper on the way | back to pick |
| 5 | Move the cube during the pick | pick follows the cube |
| 6 | Remove the cube completely | grace period → home → alert |
| 7 | Gripper closes on nothing | stays on pick and retries |
| 8 | Cube lands on the box rim | not DONE; pick again or alert |
| 9 | Kill the SSH tunnel mid-run | arm holds and stops |
| 10 | Policy stuck (hand blocks the arm) | timeout → home → retry → alert |

**Stage 3 done when** all 10 tests pass and the full task succeeds ≥ 16/20 times from random starts.

---

## 4. Tuning knobs

Measure these on real hardware. Don't trust the defaults.

| Knob | Start value | Measured |
|---|---|---|
| `YOLO_CONF` | 0.5 | |
| `DEBOUNCE_N` (frames) | 5 | |
| `WRIST_HOLD_ROI` (wrist px) | suggested by `split.py` | |
| `GRIP_HOLD_BAND` (`gripper.pos` min, max) | read from capture.py status | |
| `LOST_GRACE_S` | 2.0 | |
| `POLICY_TIMEOUT_S` | 30 | |
| `MAX_RETRIES` | 3 | |
| `NET_STALL_S` | 1.0 | |
| `actions_per_chunk` / `chunk_size_threshold` | 50 / 0.5 | |
| Robot fps | 30 | |

---

## 5. Open questions (answer before the stage that needs them)
- [ ] (S1) Is the box always in the same spot, or will it move? This decides how much variety
      the data needs.
- [ ] (S1) One cube of one colour and size, or several? Will other objects be on the table?
- [ ] (S1) JetPack version on the Orin Nano.
- [ ] (S1) Labelling tool.
- [ ] (S2) Cloud provider and region for the L4. A nearby region means lower latency, and SSH
      access is needed for the tunnel.
- [ ] (S3) One multi-task pi0.5 or two checkpoints (section 3.2).
