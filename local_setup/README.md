# local_setup — SmolVLA without the teleops SDK

LeRobot's async inference on the LAN: the Jetson reads the arm and cameras
itself, the Mac runs SmolVLA, gRPC in between. No WebRTC, no video
encode/decode, no 120 ms sync buffer.

```
Jetson 10.0.1.31 (arm + 3 USB cams)            Mac 10.0.1.26 (M4, MPS)
client.sh  (lerobot robot_client)              server.py  (lerobot policy_server)
  frames + joints every 0.1 s ── gRPC :8080 ──►  SmolVLA, 5 steps, fp32
  plays the action queue      ◄── 50-step chunk
```

## Run

```bash
# Mac
cd ~/zrt-teleops-examples && venv/bin/python local_setup/server.py

# Jetson (from the Mac: ssh videosdk@10.0.1.31)
systemctl --user stop follower              # it holds the serial port
bash ~/zrt-teleops-examples/local_setup/client.sh
```

`client.sh` settings are env vars: `SERVER`, `POLICY` (a path on the Mac),
`TASK`, `PORT`, `ARM_ID`, `MAX_STEP`. The server's are at the top of `server.py`.

## What you lose against the SDK path

- **No deadman, watchdog or dashboard e-stop.** Ctrl-C the client on the
  Jetson to stop; `disable_torque_on_disconnect` makes the arm go limp, so
  hold it or keep it low.
- **No homing**: the first chunk starts from wherever the arm is. Start from
  the rest pose. `MAX_STEP` caps every command's jump.
- **No Jev yet.**

## Notes

- macOS may ask to allow incoming connections for Python the first time; allow it.
- The Mac's `en0` is the LAN link; wired is better than Wi-Fi for gRPC frames.
- Needs `grpcio` + `protobuf` in both venvs (installed 2026-11-05).
