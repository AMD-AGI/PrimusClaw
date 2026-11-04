// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package e2b

import (
	"testing"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/grant"
)

func TestResolveTemplateReadsSpecForAFoldedTaskID(t *testing.T) {
	const run = "ktsk_01M5YDCN3QHVTA7SGJQGS8Z3RY"
	name := grant.TemplateNames(run, "dev", nil)[0]
	snap := grant.Snapshot{
		AppRunID: run,
		Roles: map[string]runtimev1alpha1.GrantRole{
			"dev": {Templates: []string{name}},
		},
		Templates: []runtimev1alpha1.GrantTemplate{{
			Name: "dev",
			Spec: `{"acceptedEnvs":["GREETING"]}`,
		}},
	}
	got, err := resolveTemplate(snap, "dev", name)
	if err != nil {
		t.Fatal(err)
	}
	if len(got.AcceptedEnvs) != 1 || got.AcceptedEnvs[0] != "GREETING" {
		t.Fatalf("accepted %v", got.AcceptedEnvs)
	}
}
