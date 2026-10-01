#!/bin/sh
# SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
# SPDX-License-Identifier: Apache-2.0

# Merge the user image's system CA bundle with extra CA anchors into
# /shared/bin/ca-bundle.pem. Runs in the sandbox's main container before envd.
#
# Calling contract: a pod template copies /setup-extra-ca.sh and
# /extra-ca-bundle.pem from the envd-injector image into /shared/bin and starts
# the main container with
#
#     /shared/bin/setup-extra-ca.sh && exec /shared/bin/envd ...
#
# The CodeInterpreter controller runs the same script the same way when
# SANDBOX_EXTRA_CA_CONFIGMAP or SANDBOX_EXTRA_CA_REQUIRED is set.
#
# Deprecated compatibility names: the injector image also ships this same file
# as /setup-amd-ca.sh and the same bundle as /amd-bundle.pem, for
# self-maintained sandbox templates written before the generic names existed.
# Invoked under either name the script behaves identically; new templates
# should use the generic names.
#
# Extra anchors come from:
#   - the bundle baked into the envd-injector image at build time
#     (EXTRA_CA_CERT_URLS; empty by default), found next to the output bundle
#     as extra-ca-bundle.pem, or under its deprecated compatibility name
#     amd-bundle.pem when only that one was copied. EXTRA_CA_IMAGE_BUNDLE
#     overrides the path;
#   - every file in /etc/claw/extra-ca (EXTRA_CA_DIR), an optional mounted
#     directory (a ConfigMap of PEM certificates); dot-entries such as the
#     kubelet's ..data are skipped.
#
# Strict mode: the container is configured to use the bundle when
# EXTRA_CA_REQUIRED=true, or when SSL_CERT_FILE, CURL_CA_BUNDLE,
# REQUESTS_CA_BUNDLE or NODE_EXTRA_CA_CERTS points at /shared/bin/ca-bundle.pem.
# Then finding no extra anchor in either place is an error: the script exits
# non-zero naming both places, so `&& exec envd` does not start a sandbox whose
# every TLS client would fail against a missing bundle.
#
# Otherwise, with no anchor found it skips and exits 0.
# A file that is present but is not a PEM certificate is an error either way.
#
# Designed for sh / dash / busybox: no bash-isms, nothing beyond cat and mv,
# non-root safe (writes only next to the output bundle).

set -eu

CA_DIR="${EXTRA_CA_DIR:-/etc/claw/extra-ca}"
OUT_BUNDLE="${EXTRA_CA_BUNDLE:-/shared/bin/ca-bundle.pem}"
BIN_DIR="${OUT_BUNDLE%/*}"
if [ -n "${EXTRA_CA_IMAGE_BUNDLE:-}" ]; then
    IMAGE_BUNDLE="$EXTRA_CA_IMAGE_BUNDLE"
elif [ ! -e "$BIN_DIR/extra-ca-bundle.pem" ] && [ -e "$BIN_DIR/amd-bundle.pem" ]; then
    # Deprecated compatibility name, copied by self-maintained sandbox
    # templates written before the rename. Same content as extra-ca-bundle.pem.
    IMAGE_BUNDLE="$BIN_DIR/amd-bundle.pem"
else
    IMAGE_BUNDLE="$BIN_DIR/extra-ca-bundle.pem"
fi
SYS_BUNDLES="${EXTRA_CA_SYSTEM_BUNDLES:-/etc/ssl/certs/ca-certificates.crt /etc/pki/tls/certs/ca-bundle.crt /etc/ssl/cert.pem}"

fail() {
    echo "setup-extra-ca: error: $*" >&2
    exit 1
}

# Why the bundle is required, or empty when it is not.
strict=""
if [ "${EXTRA_CA_REQUIRED:-false}" = "true" ]; then
    strict="EXTRA_CA_REQUIRED=true"
else
    if [ "${SSL_CERT_FILE:-}" = "$OUT_BUNDLE" ]; then
        strict="SSL_CERT_FILE=$OUT_BUNDLE"
    elif [ "${CURL_CA_BUNDLE:-}" = "$OUT_BUNDLE" ]; then
        strict="CURL_CA_BUNDLE=$OUT_BUNDLE"
    elif [ "${REQUESTS_CA_BUNDLE:-}" = "$OUT_BUNDLE" ]; then
        strict="REQUESTS_CA_BUNDLE=$OUT_BUNDLE"
    elif [ "${NODE_EXTRA_CA_CERTS:-}" = "$OUT_BUNDLE" ]; then
        strict="NODE_EXTRA_CA_CERTS=$OUT_BUNDLE"
    fi
fi

tmp="$OUT_BUNDLE.tmp.$$"
trap 'rm -f "$tmp"' EXIT
: > "$tmp" || fail "cannot write $tmp"

extras=0
add_anchor() {
    case "$(cat "$1")" in
        *"-----BEGIN CERTIFICATE-----"*) ;;
        *) fail "$1 is not a PEM certificate (no BEGIN CERTIFICATE line)" ;;
    esac
    printf '\n' >> "$tmp"
    cat "$1" >> "$tmp"
    extras=$((extras + 1))
}

if [ -s "$IMAGE_BUNDLE" ]; then
    add_anchor "$IMAGE_BUNDLE"
fi
if [ -d "$CA_DIR" ]; then
    for f in "$CA_DIR"/*; do
        if [ -f "$f" ] && [ -s "$f" ]; then
            add_anchor "$f"
        fi
    done
fi

if [ "$extras" -eq 0 ]; then
    if [ -n "$strict" ]; then
        fail "the container is configured to use $OUT_BUNDLE ($strict) but no extra CA certificate was found: $IMAGE_BUNDLE (baked into the envd-injector image with EXTRA_CA_CERT_URLS) is missing or empty, and $CA_DIR (mount a ConfigMap of PEM certificates there) holds no certificate. Refusing to start: every TLS client would fail against this bundle."
    fi
    echo "setup-extra-ca: no extra CA found at $IMAGE_BUNDLE or in $CA_DIR; skip" >&2
    exit 0
fi

sys=""
for f in $SYS_BUNDLES; do
    if [ -s "$f" ]; then
        sys="$f"
        break
    fi
done
if [ -n "$sys" ]; then
    # System anchors first, then the extras collected above.
    if ! { cat "$sys" "$tmp" > "$tmp.sys" && mv "$tmp.sys" "$tmp"; }; then
        rm -f "$tmp.sys"
        fail "cannot write $tmp"
    fi
else
    echo "setup-extra-ca: warning: no system CA bundle in this image (looked at: $SYS_BUNDLES); $OUT_BUNDLE holds only the extra anchors, so public TLS endpoints will not verify" >&2
fi

mv "$tmp" "$OUT_BUNDLE" || fail "cannot write $OUT_BUNDLE"
echo "setup-extra-ca: wrote $OUT_BUNDLE (system bundle: ${sys:-none}; extra anchor files: $extras)"
