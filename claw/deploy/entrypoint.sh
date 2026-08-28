#!/bin/sh
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

# Claw multi-role entrypoint.
# Usage (as container CMD):  api | brain | hands | <raw exec args>
set -eu

ROLE="${1:-api}"
shift || true

case "$ROLE" in
  api)
    exec node packages/api/dist/index.js "$@"
    ;;
  brain)
    exec node packages/brain/dist/index.js "$@"
    ;;
  hands)
    exec node packages/hands/dist/index.js "$@"
    ;;
  *)
    exec "$ROLE" "$@"
    ;;
esac
