// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import (
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func TestListedWorkspacesPrefersPluralKey(t *testing.T) {
	obj := &unstructured.Unstructured{Object: map[string]any{
		"spec": map[string]any{
			"resources": map[string]any{
				"workspaces": []any{"project1-dev"},
				"workspace":  []any{"other"},
			},
		},
	}}
	got, err := listedWorkspaces(obj)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0] != "project1-dev" {
		t.Fatalf("workspaces = %v", got)
	}
}

func TestListedWorkspacesFallsBackToSingularKey(t *testing.T) {
	obj := &unstructured.Unstructured{Object: map[string]any{
		"spec": map[string]any{
			"resources": map[string]any{
				"workspace": []any{"project1-dev"},
			},
		},
	}}
	got, err := listedWorkspaces(obj)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0] != "project1-dev" {
		t.Fatalf("workspace = %v", got)
	}
}
