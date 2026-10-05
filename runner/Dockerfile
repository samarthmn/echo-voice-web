FROM mcr.microsoft.com/playwright/python:v1.63.0-noble

ARG RUNNER_UID=1000
ARG RUNNER_GID=1000
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg pulseaudio pulseaudio-utils \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m pip install --no-cache-dir playwright==1.63.0
RUN test "$RUNNER_UID" -gt 0 && test "$RUNNER_GID" -gt 0 \
    && (getent group "$RUNNER_GID" >/dev/null || groupadd --gid "$RUNNER_GID" echo-runner) \
    && usermod --uid "$RUNNER_UID" --gid "$RUNNER_GID" pwuser

WORKDIR /app
COPY config.py capture.py meet_ui.py meet_runner.py container-entrypoint.sh audio_smoke.py ./
RUN chmod 755 /app/container-entrypoint.sh

# Compose maps this to the host user's UID on Unix for private shared storage.
USER pwuser
ENV ECHO_RUNNER_CONTAINER=1 \
    ECHO_CONFIG_FILE=/app/echo.config.json \
    ECHO_DATA_DIR=/data \
    TMPDIR=/app/tmp \
    XDG_RUNTIME_DIR=/app/tmp/runtime \
    PULSE_RUNTIME_PATH=/app/tmp/runtime/pulse
EXPOSE 8765
ENTRYPOINT ["/app/container-entrypoint.sh"]
