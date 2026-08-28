#!/bin/bash
# SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
# SPDX-License-Identifier: Apache-2.0

# install-kata.sh — Install Kata Containers 3.10.0 (QEMU backend) on current node
# For: Ubuntu 22.04, containerd 2.x, amd64
# Requires root privileges

set -euo pipefail

KATA_VERSION=${KATA_VERSION:-"3.10.0"}
ARCH="amd64"
KATA_TAR="/tmp/kata-static-${KATA_VERSION}-${ARCH}.tar.xz"

log()  { echo -e "\033[0;36m[INFO]\033[0m $*"; }
ok()   { echo -e "\033[0;32m[OK]\033[0m   $*"; }
err()  { echo -e "\033[0;31m[ERROR]\033[0m $*"; exit 1; }

# ── 1. Check prerequisites ────────────────────────────────────────────────────
[[ $EUID -eq 0 ]] || err "Root privileges required"
command -v containerd &>/dev/null || err "containerd not installed"

# ── 2. Download Kata static binaries ─────────────────────────────────────────
log "Downloading Kata ${KATA_VERSION} ..."
if [[ ! -f "${KATA_TAR}" ]]; then
    wget -q --show-progress \
        "https://github.com/kata-containers/kata-containers/releases/download/${KATA_VERSION}/kata-static-${KATA_VERSION}-${ARCH}.tar.xz" \
        -O "${KATA_TAR}"
fi
ok "Download complete: ${KATA_TAR}"

# ── 3. Install ────────────────────────────────────────────────────────────────
log "Extracting to /opt/kata ..."
rm -rf /opt/kata
tar xf "${KATA_TAR}" -C /

log "Creating containerd shim symlink ..."
ln -sf /opt/kata/bin/containerd-shim-kata-v2 /usr/local/bin/containerd-shim-kata-v2

# ── 4. Configure containerd ───────────────────────────────────────────────────
CONTAINERD_CFG="/etc/containerd/config.toml"
log "Configuring containerd (${CONTAINERD_CFG}) ..."

if grep -q "kata-qemu" "${CONTAINERD_CFG}" 2>/dev/null; then
    ok "kata-qemu already in containerd config, skipping"
else
    if grep -q 'disabled_plugins.*cri' "${CONTAINERD_CFG}" 2>/dev/null; then
        err "containerd config has CRI plugin disabled (disabled_plugins=[\"cri\"]), cannot add Kata. Please confirm this is a K8s node with the correct containerd config."
    fi

    cat >> "${CONTAINERD_CFG}" << 'EOF'

       [plugins."io.containerd.cri.v1.runtime".containerd.runtimes.kata-qemu]
         runtime_type = "io.containerd.kata.v2"
         privileged_without_host_devices = true
         [plugins."io.containerd.cri.v1.runtime".containerd.runtimes.kata-qemu.options]
           ConfigPath = "/opt/kata/share/defaults/kata-containers/configuration-qemu.toml"
EOF
    ok "kata-qemu runtime added to containerd config"
fi

log "Verifying containerd config syntax ..."
if containerd config dump > /dev/null 2>&1; then
    ok "containerd config syntax valid"
else
    err "containerd config syntax error, please check manually: ${CONTAINERD_CFG}"
fi

log "Restarting containerd ..."
systemctl restart containerd
sleep 3
ok "containerd restart complete"

# ── 5. Verify ─────────────────────────────────────────────────────────────────
log "Verifying Kata version ..."
/opt/kata/bin/kata-runtime --version
ok "Kata ${KATA_VERSION} installation complete!"

echo ""
echo "Next step: Create RuntimeClass in K8s cluster:"
echo "  kubectl apply -f deploy/k8s/kata/runtimeclass.yaml"
