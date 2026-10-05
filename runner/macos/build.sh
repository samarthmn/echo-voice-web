#!/bin/sh
# Build only. This never starts capture or requests macOS permissions.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
mkdir -p "$ROOT/tmp" "$ROOT/target/native-runner"
BUILD=$(mktemp -d "$ROOT/tmp/macos-capture-build.XXXXXX")
trap 'rm -rf "$BUILD"' EXIT HUP INT TERM
mkdir -p "$BUILD/module-cache" "$BUILD/scratch"
TMPDIR="$BUILD/scratch" xcrun swiftc -parse-as-library -swift-version 5 \
  -target "$(uname -m)-apple-macosx13.0" \
  -module-cache-path "$BUILD/module-cache" \
  -framework ScreenCaptureKit -framework AVFoundation -framework AppKit \
  "$ROOT/runner/macos/AudioCapture.swift" -o "$BUILD/echo-audio-capture"
mv "$BUILD/echo-audio-capture" "$ROOT/target/native-runner/echo-audio-capture"
printf '%s\n' "$ROOT/target/native-runner/echo-audio-capture"
