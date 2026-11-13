// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package identity

import (
	"net/http"
	"testing"
)

func TestCredentialPrecedence(t *testing.T) {
	tests := []struct {
		name          string
		authorization string
		apiKey        string
		caller        string
		e2b           string
	}{
		{name: "both", authorization: "Bearer access-token", apiKey: "api-key", caller: "access-token", e2b: "api-key"},
		{name: "bearer only", authorization: "Bearer access-token", caller: "access-token", e2b: "access-token"},
		{name: "api key only", apiKey: "api-key", caller: "api-key", e2b: "api-key"},
		{name: "basic scheme", authorization: "Basic dXNlcjpwYXNz", apiKey: "api-key", caller: "api-key", e2b: "api-key"},
		{name: "empty bearer", authorization: "Bearer ", apiKey: "api-key", caller: "api-key", e2b: "api-key"},
		{name: "blank api key", authorization: "Bearer access-token", apiKey: "  ", caller: "access-token", e2b: "access-token"},
		{name: "blank api key only", apiKey: "  "},
		{name: "none"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			h := http.Header{}
			if tc.authorization != "" {
				h.Set("Authorization", tc.authorization)
			}
			if tc.apiKey != "" {
				h.Set(APIKeyHeader, tc.apiKey)
			}
			if got := CallerCredential(h); got != tc.caller {
				t.Errorf("CallerCredential = %q, want %q", got, tc.caller)
			}
			if got := E2BKey(h); got != tc.e2b {
				t.Errorf("E2BKey = %q, want %q", got, tc.e2b)
			}
		})
	}
}
