"""Settings, read from .env and the environment."""

import os
from pathlib import Path

from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent


def fix() -> str:
    """Tell the reader what to do, based on whether .env exists yet."""
    if (HERE / ".env").exists():
        return "  fill it in: quickstart/.env"
    return "  cp quickstart/.env.example quickstart/.env    then edit it"


# From THIS directory, not the working directory -- a bare load_dotenv()
# searches upward from wherever you happened to run the script.
load_dotenv(HERE / ".env")

TOKEN = os.getenv("ZRT_TOKEN")
MEETING_ID = os.getenv("ZRT_MEETING_ID")
FPS = int(os.getenv("ZRT_FPS", "30"))

# By name, not a bare subscript: these are read at import, so this message
# is all a reader gets.
if not TOKEN:
    raise SystemExit("set ZRT_TOKEN -- your access token\n" + fix())
if not MEETING_ID:
    raise SystemExit("set ZRT_MEETING_ID -- the room id both ends join\n"
                     + fix())
