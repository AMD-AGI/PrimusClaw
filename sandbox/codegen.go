// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// This file just exists as a place to put //go:generate directives that should apply to the entire project

package agentsandbox

// Generate CRDs and RBAC rules
//go:generate go tool -modfile=tools.mod sigs.k8s.io/controller-tools/cmd/controller-gen object crd:maxDescLen=0 paths=./api/... output:crd:dir=k8s/crds
//go:generate go tool -modfile=tools.mod sigs.k8s.io/controller-tools/cmd/controller-gen object crd:maxDescLen=0 paths=./extensions/... output:crd:dir=k8s/crds
//go:generate go tool -modfile=tools.mod sigs.k8s.io/controller-tools/cmd/controller-gen paths=./controllers/... output:rbac:dir=k8s rbac:roleName=agent-sandbox-controller,fileName=rbac.generated.yaml
//go:generate go tool -modfile=tools.mod sigs.k8s.io/controller-tools/cmd/controller-gen paths=./extensions/controllers/... output:rbac:dir=k8s rbac:roleName=agent-sandbox-controller-extensions,fileName=extensions-rbac.generated.yaml
