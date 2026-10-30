import sys
from pathlib import Path

# studio/agent/ (planner, studio_agent, worker); they put voice/ on the path themselves.
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
