// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package identity

import "testing"

func TestRequestCredentialBearerWins(t *testing.T) {
	got := RequestCredential("Bearer access-token", "ak-key")
	if got != "access-token" {
		t.Fatalf("credential=%q", got)
	}
}

func TestE2BCredentialPrefersAPIKey(t *testing.T) {
	got := E2BCredential("Bearer access-token", "ak-key")
	if got != "ak-key" {
		t.Fatalf("credential=%q", got)
	}
	if got := E2BCredential("Bearer access-token", "  "); got != "access-token" {
		t.Fatalf("bearer fallback=%q", got)
	}
}
