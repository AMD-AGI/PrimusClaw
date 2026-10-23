// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package api

import "strings"

// FormatSandboxID builds the cluster-facing sandbox id: namespace/name.
// The name is the Sandbox (and typically Pod) object name, unique within the namespace.
func FormatSandboxID(namespace, name string) string {
	return namespace + "/" + name
}

// ParseSandboxID splits a sandbox id into namespace and name.
func ParseSandboxID(id string) (namespace, name string, ok bool) {
	namespace, name, found := strings.Cut(strings.TrimSpace(id), "/")
	if !found || namespace == "" || name == "" || strings.Contains(name, "/") {
		return "", "", false
	}
	return namespace, name, true
}
