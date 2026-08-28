// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package api

const (
	// SandboxApiKeyHeader carries the user's original API Key for the unified
	// inference gateway (§4.2). Set by Router/WM auth middleware after verification;
	// WM stores it in Redis for EnvD to pull.
	SandboxApiKeyHeader = "X-Sandbox-Api-Key"
)
