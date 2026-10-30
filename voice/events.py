"""
One JSON line per event, for looking back at a session: what was heard,
which tools ran and how long they took, what the policy saw and sent, how
the dance went.

    voice/logs/events-<YYYYmmdd-HHMMSS>.jsonl

`log()` is safe from any thread and never raises: a full disk must not stop
the arm.
"""

import json
import threading
import time
from pathlib import Path

_lock = threading.Lock()
_file = None


def open_log(directory: Path, stamp: str) -> Path:
    """Log to <directory>/events-<stamp>.jsonl from now on. Returns the path."""
    global _file
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"events-{stamp}.jsonl"
    with _lock:
        _file = open(path, "a", buffering=1, encoding="utf-8")
    return path


def log(kind: str, **fields) -> None:
    if _file is None:
        return
    line = json.dumps({"ts": round(time.time(), 3), "kind": kind, **fields},
                      default=str, ensure_ascii=False)
    try:
        with _lock:
            _file.write(line + "\n")
    except Exception:
        pass
