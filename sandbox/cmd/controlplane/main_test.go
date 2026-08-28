// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package main

import (
	"testing"

	"sigs.k8s.io/agent-sandbox/pkg/router"
)

// The control plane must not come up unauthenticated by accident: with
// EnableAuth=false no auth middleware is registered at all, and the reference
// CNI (Flannel) provides no NetworkPolicy backstop.
func TestCheckAuthPosture(t *testing.T) {
	tests := []struct {
		name       string
		enableAuth bool
		safeAPIURL string
		allowEnv   string
		wantErr    bool
	}{
		{
			name:       "auth enabled with a SaFE URL is accepted",
			enableAuth: true,
			safeAPIURL: "https://safe.example.com",
		},
		{
			name:       "auth enabled without a SaFE URL is refused",
			enableAuth: true,
			safeAPIURL: "",
			wantErr:    true,
		},
		{
			name:       "auth disabled is refused by default",
			enableAuth: false,
			wantErr:    true,
		},
		{
			name:       "auth disabled is allowed only with an explicit acknowledgement",
			enableAuth: false,
			allowEnv:   "true",
		},
		{
			name:       "a non-true acknowledgement does not count",
			enableAuth: false,
			allowEnv:   "1",
			wantErr:    true,
		},
		{
			name:       "acknowledgement is case-sensitive",
			enableAuth: false,
			allowEnv:   "TRUE",
			wantErr:    true,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("ALLOW_INSECURE_NO_AUTH", tc.allowEnv)
			cfg := router.Config{EnableAuth: tc.enableAuth, SafeAPIURL: tc.safeAPIURL}
			err := checkAuthPosture(&cfg)
			if tc.wantErr && err == nil {
				t.Fatalf("expected an error, got nil")
			}
			if !tc.wantErr && err != nil {
				t.Fatalf("expected no error, got %v", err)
			}
		})
	}
}
