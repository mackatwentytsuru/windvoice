#!/usr/bin/env bash
# Build the fnwatcher Swift sidecar as a universal (arm64 + x86_64) binary.
# Outputs to resources/native/fnwatcher, which is bundled into the .app
# by electron-builder via the `resources/**` glob.
#
# Why universal: electron-builder targets both arm64 and x64 for the mac
# DMG, so a single binary shared across both architectures is simplest.
set -euo pipefail

cd "$(dirname "$0")/.."

SRC="src/main/hotkey/native/fnwatcher.swift"
OUT_DIR="resources/native"
OUT="${OUT_DIR}/fnwatcher"

mkdir -p "$OUT_DIR"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "fnwatcher build: skipping (not macOS)"
  exit 0
fi

if ! command -v swiftc >/dev/null 2>&1; then
  echo "fnwatcher build: swiftc not found — install Xcode command line tools" >&2
  exit 1
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# Target macOS 12 minimum (matches Electron 42 deployment target). Compiling
# for each arch separately and lipo-ing them together is the standard recipe
# for a universal binary outside of Xcode.
swiftc -O -target arm64-apple-macos12.0  -o "$TMP/fnwatcher.arm64" "$SRC"
swiftc -O -target x86_64-apple-macos12.0 -o "$TMP/fnwatcher.x86_64" "$SRC"
lipo -create -output "$OUT" "$TMP/fnwatcher.arm64" "$TMP/fnwatcher.x86_64"
chmod +x "$OUT"

# Verify the resulting binary advertises both slices — saves a head-scratch
# if some future toolchain change breaks the lipo step silently.
lipo -info "$OUT"
