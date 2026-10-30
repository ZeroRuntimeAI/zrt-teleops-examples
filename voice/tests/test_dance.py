import random
from collections import Counter

import pytest

import dance
import skills


def test_every_move_stays_inside_limits_at_full_energy():
    d = dance.Dancer("energetic", random.Random(0))
    for _ in range(50):
        for pose in d.next_phrase(energy=1.0):
            for joint, v in pose.items():
                lo, hi = skills.LIMITS[joint]
                assert lo <= v <= hi, (joint, v)


def test_a_phrase_is_four_or_eight_beats_of_whole_poses():
    d = dance.Dancer("smooth", random.Random(1))
    for _ in range(20):
        phrase = d.next_phrase(0.5)
        assert len(phrase) in (4, 8)
        assert all(set(p) == set(skills.JOINTS) for p in phrase)


def test_the_mood_changes_what_gets_danced():
    def counts(mood):
        d, c = dance.Dancer(mood, random.Random(7)), Counter()
        for _ in range(200):
            d.next_phrase(0.5)
            c.update(d.last_moves)
        return c
    assert counts("energetic")["bounce"] > counts("smooth")["bounce"]
    assert counts("smooth")["sway"] > counts("robotic")["sway"]


def test_louder_music_means_bigger_moves():
    def spread(energy):
        d = dance.Dancer("energetic", random.Random(3))
        poses = [p for _ in range(30) for p in d.next_phrase(energy)]
        return max(abs(p["shoulder_pan"] - dance.DANCE_BASE["shoulder_pan"]) for p in poses)
    assert spread(1.0) > spread(0.0)


def test_unknown_moods_dance_playfully():
    assert dance.mood_of("disco!!") == "playful"
    assert dance.mood_of(" Smooth ") == "smooth"


@pytest.mark.parametrize("beat_at,expected", [(0.3, 0.25), (-0.1, -0.1), (0.9, -0.1), (2.2, 0.2)])
def test_a_heard_beat_moves_the_grid_at_most_a_quarter_beat(beat_at, expected):
    assert dance.nudge(0.0, beat_at, 1.0) == pytest.approx(expected)


def test_the_next_beat_is_on_the_grid_and_at_least_half_a_beat_away():
    assert dance.next_beat(anchor=0.0, period=0.5, t=1.1) == pytest.approx(1.5)
    assert dance.next_beat(anchor=0.0, period=0.5, t=1.3) == pytest.approx(2.0)
