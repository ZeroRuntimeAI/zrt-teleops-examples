"""
Dancing, generatively: a library of short moves picked live, weighted by
mood, sized by how loud the music is, one pose per beat.

No routine is fixed -- each phrase (4 or 8 beats) is drawn fresh -- but the
moves are small and centred on DANCE_BASE, and the controller clamps every
pose to LIMITS, so dancing can't drive the arm into the table.
"""

import math
import random

import skills

#: Where the dance happens: arm up and forward, clear of the table.
DANCE_BASE = {"shoulder_pan": 0.0, "shoulder_lift": -20.0, "elbow_flex": 30.0,
              "wrist_flex": 20.0, "wrist_roll": 0.0, "gripper": 20.0}

#: Each move is one or two beats of offsets from DANCE_BASE, at energy 0.5.
MOVES: dict[str, tuple[dict, ...]] = {
    "sway": ({"shoulder_pan": 15.0}, {"shoulder_pan": -15.0}),
    "bounce": ({"shoulder_lift": 8.0, "elbow_flex": -10.0},
               {"shoulder_lift": -8.0, "elbow_flex": 10.0}),
    "wrist_flick": ({"wrist_flex": 20.0}, {"wrist_flex": -20.0}),
    "clap": ({"gripper": 40.0}, {"gripper": -15.0}),
    "twist": ({"wrist_roll": 35.0}, {"wrist_roll": -35.0}),
    "base_swing": ({"shoulder_pan": 25.0, "wrist_roll": -15.0},
                   {"shoulder_pan": -25.0, "wrist_roll": 15.0}),
    "nod": ({"wrist_flex": 15.0},),
}

#: How often each move comes up, per mood.
MOODS: dict[str, dict[str, int]] = {
    "energetic": {"bounce": 4, "base_swing": 4, "clap": 3, "sway": 1,
                  "twist": 1, "wrist_flick": 2, "nod": 1},
    "smooth": {"sway": 5, "twist": 4, "base_swing": 1, "bounce": 1,
               "wrist_flick": 1, "clap": 1, "nod": 1},
    "robotic": {"nod": 5, "wrist_flick": 5, "clap": 2, "bounce": 1,
                "sway": 1, "twist": 1, "base_swing": 1},
    "playful": {"clap": 3, "twist": 3, "sway": 2, "bounce": 2,
                "wrist_flick": 2, "nod": 2, "base_swing": 2},
}

#: A heard beat may move the robot's beat grid by at most this share of a beat.
MAX_NUDGE = 0.25


def mood_of(word: str) -> str:
    key = str(word).strip().lower()
    return key if key in MOODS else "playful"


class Dancer:
    def __init__(self, mood: str, rng: random.Random | None = None) -> None:
        self.mood = mood_of(mood)
        self._rng = rng or random.Random()
        self.last_moves: list[str] = []

    def next_phrase(self, energy: float) -> list[dict]:
        """4 or 8 beats of whole poses (every joint), clamped to LIMITS."""
        beats = self._rng.choice((4, 8))
        scale = 0.5 + min(max(float(energy), 0.0), 1.0)
        weights = MOODS[self.mood]
        names = list(weights)
        poses, self.last_moves = [], []
        while len(poses) < beats:
            name = self._rng.choices(names, weights=[weights[n] for n in names])[0]
            self.last_moves.append(name)
            for offsets in MOVES[name]:
                poses.append({j: skills.clamp(j, DANCE_BASE[j] + offsets.get(j, 0.0) * scale)
                              for j in skills.JOINTS})
        return poses[:beats]


def nudge(anchor: float, beat_at: float, period: float) -> float:
    """Move the beat grid toward a heard beat -- by at most MAX_NUDGE of a beat."""
    delta = (beat_at - anchor) % period
    if delta > period / 2:
        delta -= period
    limit = MAX_NUDGE * period
    return anchor + max(-limit, min(limit, delta))


def next_beat(anchor: float, period: float, t: float) -> float:
    """The first beat on the grid that is at least half a beat after `t`."""
    k = math.floor((t - anchor) / period) + 1
    nb = anchor + k * period
    if nb - t < period / 2:
        nb += period
    return nb
