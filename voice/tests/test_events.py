import json
import threading

import events


def test_events_are_timestamped_json_lines(tmp_path):
    path = events.open_log(tmp_path, "t1")
    events.log("tool", name="stop", ok=True)
    rec = json.loads(path.read_text().splitlines()[-1])
    assert rec["kind"] == "tool" and rec["name"] == "stop" and rec["ts"] > 0


def test_many_threads_keep_every_line_whole(tmp_path):
    path = events.open_log(tmp_path, "t2")
    workers = [threading.Thread(target=lambda i=i: [events.log("x", i=i, n=n) for n in range(200)])
               for i in range(8)]
    for w in workers:
        w.start()
    for w in workers:
        w.join()
    lines = path.read_text().splitlines()
    assert len(lines) == 1600 and all(json.loads(l)["kind"] == "x" for l in lines)


def test_odd_values_are_written_not_raised(tmp_path):
    path = events.open_log(tmp_path, "t3")
    events.log("x", thing=object(), text="हिंदी")
    rec = json.loads(path.read_text().splitlines()[-1])
    assert rec["text"] == "हिंदी" and "object" in rec["thing"]


def test_logging_before_a_log_is_open_is_a_no_op(monkeypatch):
    monkeypatch.setattr(events, "_file", None)
    events.log("x")
