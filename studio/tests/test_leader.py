import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import leader as studio_leader  # noqa: E402  (studio/leader.py, not quickstart/)

# The hash the browser follower announces for the SO-101 schema.
STUDIO_SCHEMA = "42f4c231"


def test_schema_matches_studio():
    assert studio_leader.StudioLeader.descriptor_static().schema_hash == STUDIO_SCHEMA


def test_wave_is_bounded(monkeypatch):
    clock = [100.0]
    monkeypatch.setattr(studio_leader, "monotonic", lambda: clock[0])
    arm = studio_leader.StudioLeader("room", token="t")

    pans = []
    for i in range(401):  # one full 0.25 Hz period, every 10 ms
        clock[0] = 100.0 + i * 0.01
        joints = arm.read_joints()
        pans.append(joints["shoulder_pan"])
        for name, home in studio_leader.HOME.items():
            if name != "shoulder_pan":
                assert joints[name] == home

    assert all(-20.0 <= p <= 20.0 for p in pans)
    assert max(pans) > 19.9 and min(pans) < -19.9  # it really swings


def test_main_needs_token_and_room(monkeypatch):
    monkeypatch.delenv("ZERORUNTIME_AUTH_TOKEN", raising=False)
    monkeypatch.delenv("ZERORUNTIME_MEETING_ID", raising=False)
    with pytest.raises(SystemExit):
        studio_leader.main()
