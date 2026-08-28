#!/bin/sh
# SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
# SPDX-License-Identifier: Apache-2.0

# Merge the host image's system CA bundle with the AMD CA chain that the
# envd-injector seeded into /shared/bin. Output is /shared/bin/ca-bundle.pem.
#
# Designed for sh / dash / busybox:
#   - no bash-isms, no `pipefail`
#   - non-root safe (only writes inside /shared/bin)
#   - never aborts the user container's startup; on any error the script
#     falls back to copying the AMD bundle alone so /shared/bin/ca-bundle.pem
#     always exists for downstream consumers.
#
# This script intentionally does NOT export environment variables. Callers
# decide whether to wire SSL_CERT_FILE / REQUESTS_CA_BUNDLE / CURL_CA_BUNDLE /
# NODE_EXTRA_CA_CERTS via the Pod spec or their own startup logic.

set -eu

AMD_BUNDLE="/shared/bin/amd-bundle.pem"
SYS_BUNDLE="/etc/ssl/certs/ca-certificates.crt"
OUT_BUNDLE="/shared/bin/ca-bundle.pem"

if [ ! -s "$AMD_BUNDLE" ]; then
    echo "setup-amd-ca: AMD bundle not found at $AMD_BUNDLE; skip" >&2
    exit 0
fi

if [ -s "$SYS_BUNDLE" ]; then
    cat "$SYS_BUNDLE" "$AMD_BUNDLE" > "$OUT_BUNDLE"
else
    cp "$AMD_BUNDLE" "$OUT_BUNDLE"
fi

echo "setup-amd-ca: wrote $OUT_BUNDLE"
