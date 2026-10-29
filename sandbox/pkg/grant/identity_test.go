// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import (
	"context"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynfake "k8s.io/client-go/dynamic/fake"
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

func userObject(name, role, workspace string) *unstructured.Unstructured {
	spec := map[string]any{
		"resources": map[string]any{"workspaces": []any{workspace}},
	}
	if role != "" {
		spec["roles"] = []any{role}
	}
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "amd.com/v1",
		"kind":       "User",
		"metadata":   map[string]any{"name": name},
		"spec":       spec,
	}}
}

func TestSystemAdminIgnoresWorkspaceMembership(t *testing.T) {
	user := userObject("admin-1", systemAdminRole, "global-control-plane")
	dc := dynfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{
		userGVR: "UserList",
	}, user)
	err := NewUserCRMembership(dc).Check(context.Background(), "admin-1", []string{"top-models"})
	if err != nil {
		t.Fatal(err)
	}
}

func TestMemberStillNeedsTheWorkspace(t *testing.T) {
	user := userObject("user-1", "", "global-control-plane")
	dc := dynfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{
		userGVR: "UserList",
	}, user)
	err := NewUserCRMembership(dc).Check(context.Background(), "user-1", []string{"top-models"})
	if !IsReason(err, "user_not_in_workspace") {
		t.Fatalf("err=%v", err)
	}
}
