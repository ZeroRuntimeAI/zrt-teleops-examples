#!/usr/bin/env python3
"""
Capture poses for skills.py by moving the arm by hand.

    python capture_pose.py

Stop so101/follower.py first: this opens the arm's serial port itself, turns
the torque OFF, and prints the joints whenever you press Enter. Support the
arm -- with torque off it drops under its own weight.

Paste the printed lines into POSES in skills.py.

Needs ZERORUNTIME_FOLLOWER_PORT and ZERORUNTIME_FOLLOWER_ID from so101/.env.
"""

import os
from pathlib import Path

from dotenv import load_dotenv
from lerobot.robots.so_follower import SO101Follower, SO101FollowerConfig

load_dotenv(Path(__file__).resolve().parent.parent / "so101" / ".env")


def main() -> None:
    port = os.getenv("ZERORUNTIME_FOLLOWER_PORT")
    arm_id = os.getenv("ZERORUNTIME_FOLLOWER_ID")
    if not port or not arm_id:
        raise SystemExit("set ZERORUNTIME_FOLLOWER_PORT and "
                         "ZERORUNTIME_FOLLOWER_ID in so101/.env")
    arm = SO101Follower(SO101FollowerConfig(port=port, id=arm_id))
    arm.connect(calibrate=False)
    try:
        input("Torque goes OFF next and the arm will drop. "
              "Support it, then press Enter. ")
        arm.bus.disable_torque()
        while True:
            name = input("pose name (Enter to print, ctrl-c to quit): ").strip()
            obs = arm.get_observation()
            pose = {k.removesuffix(".pos"): round(float(v), 1)
                    for k, v in obs.items() if k.endswith(".pos")}
            print(f'    "{name or "pose"}": {pose},')
    except KeyboardInterrupt:
        pass
    finally:
        arm.disconnect()


if __name__ == "__main__":
    main()
