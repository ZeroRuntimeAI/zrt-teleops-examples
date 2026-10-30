"""Settings, read from voice/.env and the environment."""

import os
from pathlib import Path

from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent

# From THIS directory, not the working directory -- a bare load_dotenv()
# searches upward from wherever you happened to run the script.
load_dotenv(HERE / ".env")

FPS = int(os.getenv("ZERORUNTIME_FPS", "30"))
WEB_PORT = int(os.getenv("ZERORUNTIME_WEB_PORT", "8000"))


def fix() -> str:
    """Tell the reader what to do, based on whether .env exists yet."""
    if (HERE / ".env").exists():
        return "  fill it in: voice/.env"
    return "  cp voice/.env.example voice/.env    then edit it"


def required(name: str, what: str) -> str:
    """A variable main() can't run without. Read from main(), not at import,
    so every module imports -- and every test runs -- with no .env at all."""
    value = os.getenv(name)
    if not value:
        raise SystemExit(f"set {name} -- {what}\n" + fix())
    return value
