#!/bin/bash
# Copyright Advanced Micro Devices, Inc.
# SPDX-License-Identifier: MIT

set -e
cd "$(dirname "$0")/.."
if [ -f .env ]; then set -a; source .env; set +a; fi
export BRAIN_ID="${BRAIN_ID:-brain-$(whoami)}"
cd packages/brain && npx tsx watch src/index.ts
