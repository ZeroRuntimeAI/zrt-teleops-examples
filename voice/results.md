# Real-arm pick and place: live results, 2 November 2026

The SO-101 picks an orange 3 cm cube off the table and places it on top of a
brown cardboard box. No learned policy is involved. The table camera finds the
cube and the box, and a scripted planner moves the arm on a kinematic model
corrected from 10 teleoperated demonstrations.

## Setup

| Item | Value |
|---|---|
| Arm | SO-101 follower on a Jetson Orin, room `u31f-7w5c-0850` |
| Cameras | top (fixed, used for positions), side, wrist |
| Pointing model | Gemini 3.1 Flash-Lite, free tier |
| Arm correction | fitted from 10 teleoperated grasps, session `20261102-082936` |
| Box top | 5.3 cm above the table, measured from the demo releases |
| Code | branch `feat/real-arm`, `voice/real_agent.py` |

Positions below are in the arm's frame: distance out from the base, then
sideways (negative is to the arm's left, where the box sits).

## Headline

| Measure | Result |
|---|---|
| Runs where the arm moved | 12 |
| First-try grasp, inside the demo area | **7 of 7** |
| First-try grasp, outside the demo area | 1 of 5 |
| Held cubes that ended on the box | 5 of 7 |
| Full pick and place, start to finish | 5 of 12 |
| Time per successful run | 20 to 25 s |

The demo area is where the teleoperated grasps were recorded: 20 to 36 cm
out, from 14 cm left to 7 cm right of centre.

## Every run

| # | Cube (out, side) cm | In demo area | Grasp | On box | Cause of failure |
|---|---|---|---|---|---|
| 1 | 20.5, −6.8 | yes | first try | yes | |
| 2 | 30.5, −7.4 | yes | first try | yes | |
| 3 | 31.9, −0.6 | yes | first try | yes | |
| 4 | 20.1, +22.9 | no, right side | missed twice | no | no demo data on the right |
| 5 | 28.7, −2.1 | yes | first try | no | box mis-sighted: the model pointed at the cube's own spot |
| 6 | 30.0, −7.4 | yes | first try | yes | |
| 7 | 20.9, −4.8 | yes | first try | yes | |
| 8 | 15.6, −6.3 | no, near | missed, then refused | no | no demo data near the base |
| 9 | 13.6, −5.2 | no, near | first try | no | box target off by ~1 cm on a bumped box; cube slid off the far edge |
| 10 | 35.5, −16.4 | edge | first try | not finished | loop restarted mid-run (operator error) |
| 11 | 13.0, −6.1 | no, near | missed twice | no | near the base |
| 12 | 17.4, −9.3 | no, near | missed | no | near the base |

In five more looks the cube sat 9 to 15 cm out and the planner refused it
without moving the arm.

## What the arm correction did

The simulator's arm model, uncorrected, put the grasp point about 5 cm from
where the real jaws closed in the demos, mostly too high.

| Model | Median grasp-point error |
|---|---|
| Uncorrected | 4.9 cm |
| Corrected, demos used in the fit | 1.3 cm |
| Corrected, each demo left out of its own fit | 2.0 cm (height alone 0.7 cm) |

Before the correction, autonomous grasps failed every time: the jaws closed
2 to 3 cm above the cube.

## Failure analysis

**Grasps outside the demo area (4 of 5 failed).** The correction is fitted
where the demos were, and extrapolates poorly beyond them. Every failure was
near the base (13 to 17 cm) or on the right side, where no demo was recorded.

**Box targeting (2 of 7 placements failed).** Neither was arm accuracy.

- Run 5: one sighting of "the box" landed on the wrong object, likely
  confused by a laptop next to it.
- Run 9: the box had been bumped 2.7 cm since the start. Single sightings
  scatter 1 to 2 cm, and this one fell 1 cm past the centre on the far side.

**Near-base refusals.** The arm can physically reach 9 cm out with an angled
approach, inside the hardware joint limits. The planner refuses because it
prefers a near-vertical approach and its tighter software limits rule that out.

## Changed since these runs, not yet tested live

- Before placing, the box is sighted three times and the median used, so a
  bumped box is followed and one wild sighting is thrown out.
- Close to the base, the travel height drops from 12 cm to 10 or 8 cm.

## Next steps

1. Allow an angled approach for cubes near the base.
2. Record about 6 more teleoperated grasps, 3 near the base and 3 on the
   right side, and refit the correction.
3. Rerun the loop over the whole table and update this file.
