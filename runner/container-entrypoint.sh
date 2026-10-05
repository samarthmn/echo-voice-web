#!/bin/sh
set -eu
umask 077
mkdir -p "$XDG_RUNTIME_DIR" "$PULSE_RUNTIME_PATH"
# The image maps its entire /tmp to /app/tmp, including X11's required lock and
# socket names. No host temp directory or additional display port is used.
mkdir -p /app/tmp/.X11-unix
chmod 1777 /app/tmp/.X11-unix
Xvfb :99 -screen 0 1280x900x24 -nolisten tcp > /app/tmp/xvfb.log 2>&1 &
xvfb_pid=$!
for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if [ -S /app/tmp/.X11-unix/X99 ]; then break; fi
    if ! kill -0 "$xvfb_pid" 2>/dev/null; then cat /app/tmp/xvfb.log >&2; exit 1; fi
    sleep 0.2
done
if [ ! -S /app/tmp/.X11-unix/X99 ]; then cat /app/tmp/xvfb.log >&2; echo "The private recording-browser display did not start." >&2; exit 1; fi
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
