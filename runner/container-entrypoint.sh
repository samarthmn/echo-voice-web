#!/bin/sh
set -eu
umask 077
mkdir -p "$XDG_RUNTIME_DIR" "$PULSE_RUNTIME_PATH"
# All audio devices are virtual and stay inside this container.
pulseaudio --daemonize=yes --exit-idle-time=-1 --log-target=stderr
pactl info >/dev/null
if [ "$#" -gt 0 ]; then
    exec "$@"
fi
# Readiness is published only after real browser playback reaches an audible WAV.
rm -f "$XDG_RUNTIME_DIR/audio-qualified"
python3 /app/audio_smoke.py
touch "$XDG_RUNTIME_DIR/audio-qualified"
exec python3 -u /app/meet_runner.py --container-bind --port 8765
