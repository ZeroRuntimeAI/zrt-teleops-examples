# Studio's voice worker. Build from the repo root -- it needs voice/ and the sim MJCF:
#
#   docker build -f studio/agent/Dockerfile -t studio-voice .
#   docker run -e ZERORUNTIME_AUTH_TOKEN=... -e ZERORUNTIME_AGENT_ID=... studio-voice
#
# ZERORUNTIME_AGENT_ID must match the Studio server's STUDIO_VOICE_AGENT_ID. No secret is baked in.

FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY studio/agent/requirements.txt studio/agent/requirements.txt
RUN pip install -r studio/agent/requirements.txt
# The same layout as the repo: studio_agent.py finds voice/ and the MJCF relative to itself.
COPY voice/ voice/
COPY studio/public/sim/ studio/public/sim/
COPY studio/agent/ studio/agent/
RUN useradd --create-home worker
USER worker
CMD ["python", "studio/agent/worker.py"]
