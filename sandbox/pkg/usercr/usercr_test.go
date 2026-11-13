// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package usercr

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynfake "k8s.io/client-go/dynamic/fake"
	k8stesting "k8s.io/client-go/testing"

	"sigs.k8s.io/agent-sandbox/pkg/authz"
	"sigs.k8s.io/agent-sandbox/pkg/identity"
)

// userCR returns a UserCR over a fake client holding objs.
func userCR(objs ...runtime.Object) (*UserCR, *dynfake.FakeDynamicClient) {
	dc := dynfake.NewSimpleDynamicClientWithCustomListKinds(runtime.NewScheme(), map[schema.GroupVersionResource]string{UserGVR: "UserList"}, objs...)
	return NewUserCR(dc), dc
}

// user builds a SaFE User with spec.
func user(name string, spec map[string]any) *unstructured.Unstructured {
	return &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "amd.com/v1",
		"kind":       "User",
		"metadata":   map[string]any{"name": name},
		"spec":       spec,
	}}
}

func TestUserCRRead(t *testing.T) {
	m, _ := userCR(
		user("u-list", map[string]any{"resources": map[string]any{"workspaces": []any{"lab", "prod"}}}),
		user("u-single", map[string]any{"resources": map[string]any{"workspace": []any{"lab"}}}),
		user("u-both", map[string]any{"resources": map[string]any{"workspaces": []any{"prod"}, "workspace": []any{"lab"}}}),
		user("u-admin", map[string]any{"roles": []any{"default", identity.RoleSystemAdmin}}),
		user("u-readonly", map[string]any{"roles": []any{identity.RoleSystemAdminReadonly}}),
	)
	for _, tc := range []struct {
		id   string
		want User
	}{
		{"u-list", User{Found: true, Workspaces: []string{"lab", "prod"}}},
		{"u-single", User{Found: true, Workspaces: []string{"lab"}}},
		{"u-both", User{Found: true, Workspaces: []string{"prod"}}},
		{"u-admin", User{Found: true, Admin: true}},
		{"u-readonly", User{Found: true}},
		{"u-missing", User{}},
	} {
		got, err := m.Read(context.Background(), tc.id)
		if err != nil || !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: %+v %v, want %+v", tc.id, got, err, tc.want)
		}
	}
}

func TestUserCRReadAPIErrorIsUnavailable(t *testing.T) {
	m, dc := userCR()
	dc.PrependReactor("get", "users", func(k8stesting.Action) (bool, runtime.Object, error) {
		return true, nil, errors.New("connection refused")
	})
	if _, err := m.Read(context.Background(), "u-1"); !errors.Is(err, authz.ErrUnavailable) {
		t.Fatalf("err=%v", err)
	}
	var none *UserCR
	if _, err := none.Read(context.Background(), "u-1"); !errors.Is(err, authz.ErrUnavailable) {
		t.Fatalf("unconfigured err=%v", err)
	}
}

func TestUserCRReadMalformedWorkspacesIsNotAMember(t *testing.T) {
	m, _ := userCR(user("u-bad", map[string]any{"resources": map[string]any{"workspaces": "lab"}}))
	if _, err := m.Read(context.Background(), "u-bad"); !errors.Is(err, authz.ErrNotInWorkspace) {
		t.Fatalf("err=%v", err)
	}
}
