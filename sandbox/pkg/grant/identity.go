// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import (
	"context"
	"net/http"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"

	"sigs.k8s.io/agent-sandbox/pkg/safe"
)

// userGVR is the cluster-scoped SaFE User CR. Its name is the user id.
var userGVR = schema.GroupVersionResource{Group: "amd.com", Version: "v1", Resource: "users"}

// IdentityChecker confirms the delegated platform key belongs to the grant owner.
type IdentityChecker interface {
	Check(ctx context.Context, platformKey, userID string) (userName string, err error)
}

// SafeIdentityChecker calls SaFE's API-key verification.
type SafeIdentityChecker struct {
	client *safe.Client
}

// NewSafeIdentityChecker wraps a SaFE client.
func NewSafeIdentityChecker(client *safe.Client) *SafeIdentityChecker {
	return &SafeIdentityChecker{client: client}
}

// Check verifies the platform key and requires the returned user id to match.
func (c *SafeIdentityChecker) Check(ctx context.Context, platformKey, userID string) (string, error) {
	if c == nil || c.client == nil {
		return "", opErr(http.StatusServiceUnavailable, "identity_unavailable", "SaFE client is not configured")
	}
	info, err := c.client.VerifyAPIKey(ctx, platformKey)
	if err != nil {
		return "", opErr(http.StatusForbidden, "platform_key_rejected", "platform key was rejected")
	}
	if info.UserID != userID {
		return "", opErr(http.StatusForbidden, "user_mismatch", "platform key user does not match owner.userId")
	}
	return info.UserName, nil
}

// MembershipChecker confirms the user belongs to every requested workspace.
type MembershipChecker interface {
	Check(ctx context.Context, userID string, workspaces []string) error
}

// UserCRMembership reads users.amd.com and compares the workspace list.
type UserCRMembership struct {
	client dynamic.Interface
}

// NewUserCRMembership reads cluster-scoped User objects named by user id.
func NewUserCRMembership(client dynamic.Interface) *UserCRMembership {
	return &UserCRMembership{client: client}
}

// listedWorkspaces reads spec.resources.workspaces, which is the key SaFE writes.
// spec.resources.workspace is accepted when that key is absent.
func listedWorkspaces(obj *unstructured.Unstructured) ([]string, error) {
	for _, key := range []string{"workspaces", "workspace"} {
		got, found, err := unstructured.NestedStringSlice(obj.Object, "spec", "resources", key)
		if err != nil {
			return nil, err
		}
		if found {
			return got, nil
		}
	}
	return nil, nil
}

// Check rejects a missing user and any workspace not listed on the User.
func (m *UserCRMembership) Check(ctx context.Context, userID string, workspaces []string) error {
	if m == nil || m.client == nil {
		return opErr(http.StatusServiceUnavailable, "membership_unavailable", "User client is not configured")
	}
	obj, err := m.client.Resource(userGVR).Get(ctx, userID, metav1.GetOptions{})
	if err != nil {
		return opErr(http.StatusForbidden, "user_not_in_workspace", "user was not found")
	}
	got, err := listedWorkspaces(obj)
	if err != nil {
		return opWrap(http.StatusForbidden, "user_not_in_workspace", "workspace list is unreadable", err)
	}
	for _, ws := range workspaces {
		if !contains(got, ws) {
			return opErr(http.StatusForbidden, "user_not_in_workspace", ws)
		}
	}
	return nil
}
