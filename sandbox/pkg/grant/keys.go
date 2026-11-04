// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import "strings"

// FormatKeyHashes encodes role=hash pairs for the grant annotation.
func FormatKeyHashes(hashes map[string]string) string {
	parts := make([]string, 0, len(hashes))
	for role, hash := range hashes {
		parts = append(parts, role+"="+hash)
	}
	return strings.Join(parts, ",")
}

// ParseKeyHashes decodes a key-hash annotation. Malformed pairs are skipped.
func ParseKeyHashes(raw string) map[string]string {
	out := make(map[string]string)
	if raw == "" {
		return out
	}
	for _, part := range strings.Split(raw, ",") {
		role, hash, ok := strings.Cut(part, "=")
		if !ok || role == "" || hash == "" {
			continue
		}
		out[role] = hash
	}
	return out
}

// RoleForHash returns the role whose stored hash matches hash.
func RoleForHash(hashes map[string]string, hash string) (string, bool) {
	for role, got := range hashes {
		if got == hash {
			return role, true
		}
	}
	return "", false
}
