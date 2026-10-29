// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import (
	"os"
	"strings"
)

// AllowedCallersFromEnv reads GRANT_ALLOWED_SERVICEACCOUNTS, a comma-separated
// list of Kubernetes usernames allowed to call the grant admin API.
func AllowedCallersFromEnv() []string {
	raw := strings.TrimSpace(os.Getenv("GRANT_ALLOWED_SERVICEACCOUNTS"))
	if raw == "" {
		return nil
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

// DataKeyFromEnv reads GRANT_DATA_KEY (base64 AES key). An empty env var
// returns a nil key so the process can still start; issue then fails closed.
func DataKeyFromEnv() ([]byte, error) {
	raw := strings.TrimSpace(os.Getenv("GRANT_DATA_KEY"))
	if raw == "" {
		return nil, nil
	}
	return DecodeDataKey(raw)
}

// JWKSFromEnv reads GRANT_JWKS, or the file named by GRANT_JWKS_FILE.
// An empty result means attestation verification is not configured.
func JWKSFromEnv() ([]byte, error) {
	if path := strings.TrimSpace(os.Getenv("GRANT_JWKS_FILE")); path != "" {
		return os.ReadFile(path)
	}
	if raw := strings.TrimSpace(os.Getenv("GRANT_JWKS")); raw != "" {
		return []byte(raw), nil
	}
	return nil, nil
}

// Namespace returns GRANT_NAMESPACE when set, otherwise fallback.
func Namespace(fallback string) string {
	if ns := strings.TrimSpace(os.Getenv("GRANT_NAMESPACE")); ns != "" {
		return ns
	}
	return fallback
}
