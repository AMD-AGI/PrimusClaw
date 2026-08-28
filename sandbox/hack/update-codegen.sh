#!/bin/bash
# SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
# SPDX-License-Identifier: Apache-2.0

# update-codegen.sh — Generate typed K8s clients for CodeInterpreter/AgentRuntime CRDs
#
# Generated output:
#   client-go/clientset/   — Typed CRUD client
#   client-go/informers/   — Auto-sync cache
#   client-go/listers/     — Read-only cache queries
#
# Prerequisites (install before first run):
#   go install k8s.io/code-generator/cmd/client-gen@v0.32.0
#   go install k8s.io/code-generator/cmd/informer-gen@v0.32.0
#   go install k8s.io/code-generator/cmd/lister-gen@v0.32.0
#   go install k8s.io/code-generator/cmd/deepcopy-gen@v0.32.0
#   go install sigs.k8s.io/controller-tools/cmd/controller-gen@v0.17.0
#
# Usage:
#   ./hack/update-codegen.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
MODULE="sigs.k8s.io/agent-sandbox"
CLIENT_GO_PKG="${MODULE}/client-go"
API_PKG="${MODULE}/pkg/apis"

echo "=== Generate CRD YAML (controller-gen) ==="
controller-gen \
  crd:generateEmbeddedObjectMeta=true \
  paths="${REPO_ROOT}/pkg/apis/..." \
  output:crd:artifacts:config="${REPO_ROOT}/deploy/crds/runtime"

echo "=== Generate DeepCopy (deepcopy-gen) ==="
deepcopy-gen \
  --input-dirs "${API_PKG}/runtime/v1alpha1" \
  --output-package "${API_PKG}/runtime/v1alpha1" \
  --output-file-base zz_generated.deepcopy \
  --go-header-file "${SCRIPT_DIR}/boilerplate.go.txt"

echo "=== Generate Clientset (client-gen) ==="
client-gen \
  --clientset-name versioned \
  --input-base "" \
  --input "${API_PKG}/runtime/v1alpha1" \
  --output-package "${CLIENT_GO_PKG}/clientset" \
  --go-header-file "${SCRIPT_DIR}/boilerplate.go.txt"

echo "=== Generate Listers (lister-gen) ==="
lister-gen \
  --input-dirs "${API_PKG}/runtime/v1alpha1" \
  --output-package "${CLIENT_GO_PKG}/listers" \
  --go-header-file "${SCRIPT_DIR}/boilerplate.go.txt"

echo "=== Generate Informers (informer-gen) ==="
informer-gen \
  --input-dirs "${API_PKG}/runtime/v1alpha1" \
  --versioned-clientset-package "${CLIENT_GO_PKG}/clientset/versioned" \
  --listers-package "${CLIENT_GO_PKG}/listers" \
  --output-package "${CLIENT_GO_PKG}/informers" \
  --go-header-file "${SCRIPT_DIR}/boilerplate.go.txt"

echo "=== go mod tidy ==="
cd "${REPO_ROOT}" && go mod tidy

echo "✅ client-go code generation complete"
echo "   Output location: ${REPO_ROOT}/client-go/"
