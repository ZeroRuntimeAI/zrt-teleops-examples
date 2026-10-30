#!/usr/bin/env bash
# The voice demo, both sides, one command.
#
#   ./demo.sh up       start the follower (here, or on ROBOT_HOST over ssh), then the agent
#   ./demo.sh status   what is running where, faults, log paths, the page link
#   ./demo.sh logs     follow the agent, events and follower logs
#   ./demo.sh down     stop the agent; the follower keeps holding the arm
#   ./demo.sh down all ...and the follower too: torque goes off, rest the arm first
#
# Settings from voice/.env: ROBOT_HOST (ssh host; unset = this machine),
# ROBOT_DIR (the follower's folder there), ROBOT_PYTHON (its python).
# Logs: voice/logs/ here; ~/voice-demo/logs/ wherever the follower runs.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS="$HERE/logs"
mkdir -p "$LOGS"
env_get() { grep -E "^$1=" "$HERE/.env" 2>/dev/null | tail -1 | cut -d= -f2-; }
ROBOT_HOST="${ROBOT_HOST-$(env_get ROBOT_HOST)}"
ROBOT_DIR="${ROBOT_DIR:-$(env_get ROBOT_DIR)}"
ROBOT_DIR="${ROBOT_DIR:-$HERE/../so101}"
ROBOT_PYTHON="${ROBOT_PYTHON:-$(env_get ROBOT_PYTHON)}"
ROBOT_PYTHON="${ROBOT_PYTHON:-$HERE/../.venv/bin/python}"
PY="$HERE/../.venv/bin/python"
# Bracketed: pgrep/pkill must not match the ssh shell carrying this pattern.
# [Pp]: macOS's framework Python re-execs as .../Python.app/.../Python.
FOLLOWER='[Pp]ython -u follower.py'
AGENT_PID="$LOGS/agent.pid"
WHERE="${ROBOT_HOST:-this machine}"

robot() {  # run a shell snippet where the follower lives
  if [ -n "$ROBOT_HOST" ]; then
    ssh -o ConnectTimeout=10 -o BatchMode=yes "$ROBOT_HOST" "$1"
  else
    bash -c "$1"
  fi
}

agent_alive() { [ -f "$AGENT_PID" ] && kill -0 "$(cat "$AGENT_PID")" 2>/dev/null; }
open_url() { if command -v open >/dev/null; then open "$1"; else xdg-open "$1" >/dev/null 2>&1 || true; fi; }
page_url() { grep -ao 'http://localhost:[0-9]*/?room=[^ ]*' "$LOGS/agent-latest.log" 2>/dev/null | tail -1; }

up() {
  local ts; ts="$(date +%Y%m%d-%H%M%S)"
  echo "== follower on $WHERE"
  # Check and start are separate calls: a shell whose own command line holds
  # "python -u follower.py" would match the pgrep and never start it.
  robot "pgrep -f '$FOLLOWER' >/dev/null"
  case $? in
    0) echo "  already running" ;;
    1) robot "mkdir -p ~/voice-demo/logs && cd $ROBOT_DIR &&
              (printf '\n' | nohup $ROBOT_PYTHON -u follower.py > ~/voice-demo/logs/follower-$ts.log 2>&1 &) &&
              ln -sf ~/voice-demo/logs/follower-$ts.log ~/voice-demo/logs/follower-latest.log" \
         || { echo "  could not start it on $WHERE"; return 1; }
       echo "  started" ;;
    *) echo "  could not reach $WHERE"; return 1 ;;
  esac
  if ! robot "for i in \$(seq 60); do grep -q 'robot ready' ~/voice-demo/logs/follower-latest.log 2>/dev/null && exit 0; sleep 1; done; exit 1"; then
    echo "  follower did not come up -- last lines:"
    robot "tail -n 8 ~/voice-demo/logs/follower-latest.log"
    return 1
  fi
  echo "  robot ready"
  echo "== agent on this machine"
  if agent_alive; then
    echo "  already running (pid $(cat "$AGENT_PID"))"
  else
    # exec: the pid file must hold python itself, not a subshell around it.
    (cd "$HERE" && exec nohup "$PY" -u agent.py > "$LOGS/agent-$ts.log" 2>&1 < /dev/null) &
    echo $! > "$AGENT_PID"
    ln -sf "$LOGS/agent-$ts.log" "$LOGS/agent-latest.log"
    echo -n "  starting (the pick-up model can take a few minutes) "
    for i in $(seq 600); do
      if grep -aq "invoked '" "$LOGS/agent-latest.log"; then break; fi
      # A logged traceback alone is not fatal; a dead agent or no control is.
      if grep -aqE "no control in|on_ready failed" "$LOGS/agent-latest.log" || ! agent_alive; then
        echo; echo "  agent failed -- last lines:"; tail -n 12 "$LOGS/agent-latest.log"; return 1
      fi
      [ $((i % 10)) -eq 0 ] && echo -n "."
      sleep 1
    done
    echo " joined"
  fi
  local url; url="$(page_url)"
  [ -n "$url" ] && open_url "$url"
  status
}

# TERM, not INT: both were started in the background, where a script's
# children ignore ctrl-c. Both SDKs take TERM as a clean stop -- the agent
# holds the arm and leaves, the follower releases and disconnects.
down() {
  echo "== agent"
  if agent_alive; then
    local pid; pid="$(cat "$AGENT_PID")"
    kill -TERM "$pid"
    for i in $(seq 30); do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
    if kill -0 "$pid" 2>/dev/null; then echo "  still stopping (pid $pid)"; else echo "  stopped"; fi
  else
    echo "  not running"
  fi
  rm -f "$AGENT_PID"
  if [ "${1:-}" != all ]; then
    echo "== follower on $WHERE: left running, holding the arm"
    echo "  rest the arm, then: $0 down all"
    return 0
  fi
  echo "== follower on $WHERE (torque goes off -- the arm should be resting)"
  robot "if pgrep -f '$FOLLOWER' >/dev/null; then pkill -TERM -f '$FOLLOWER';
           for i in \$(seq 60); do pgrep -f '$FOLLOWER' >/dev/null || break; sleep 0.5; done;
           if pgrep -f '$FOLLOWER' >/dev/null; then echo '  still stopping'; else echo '  stopped'; fi;
         else echo '  not running'; fi"
}

status() {
  echo "== agent (this machine)"
  if agent_alive; then
    local pid; pid="$(cat "$AGENT_PID")"
    echo "  running  pid $pid  up $(ps -o etime= -p "$pid" | tr -d ' ')"
  else
    echo "  stopped"
  fi
  echo "  log     $(readlink "$LOGS/agent-latest.log" 2>/dev/null || echo none)"
  local ev; ev="$(ls -t "$LOGS"/events-*.jsonl 2>/dev/null | head -1)"
  echo "  events  ${ev:-none}"
  [ -n "$ev" ] && echo "  last    $(tail -1 "$ev" | cut -c1-140)"
  local url; url="$(page_url)"
  [ -n "$url" ] && echo "  page    ${url%%&token=*}&token=<in agent log>"
  echo "== follower ($WHERE)"
  robot "p=\$(pgrep -f '$FOLLOWER' | head -1)
         if [ -n \"\$p\" ]; then echo \"  running  pid \$p  up \$(ps -o etime= -p \$p | tr -d ' ')\"; else echo '  stopped'; fi
         f=\$(readlink -f ~/voice-demo/logs/follower-latest.log 2>/dev/null)
         echo \"  log     \${f:-none}\"
         if [ -n \"\$f\" ]; then echo \"  faults  joint_read=\$(grep -c 'joint read fault' \$f)  robot_fault=\$(grep -c robot_fault \$f)  port_in_use=\$(grep -c 'Port is in use' \$f)  camera=\$(grep -c 'read failed' \$f)\"; fi" \
    || echo "  could not reach $WHERE"
  return 0
}

logs() {
  # Background jobs ignore ctrl-c in a script: take the follower tail down too.
  trap 'kill 0' EXIT
  robot "tail -n 20 -F ~/voice-demo/logs/follower-latest.log" | sed -u 's/^/[follower] /' &
  local ev; ev="$(ls -t "$LOGS"/events-*.jsonl 2>/dev/null | head -1)"
  # The agent log prints the page link, token and all: keep it off the screen.
  tail -n 20 -F "$LOGS/agent-latest.log" ${ev:+"$ev"} | sed -u -E 's/token=[^ &"]*/token=<redacted>/g; s/^/[agent] /'
}

case "${1:-status}" in
  up) up ;; down) down "${2:-}" ;; status) status ;; logs) logs ;;
  *) echo "usage: $0 up | down [all] | status | logs"; exit 2 ;;
esac
