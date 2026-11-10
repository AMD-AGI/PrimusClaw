// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import (
	"context"
	"errors"
	"net/http"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"

	"sigs.k8s.io/agent-sandbox/pkg/identity"
)

// userGVR is the cluster-scoped SaFE User CR. Its name is the user id.
var userGVR = schema.GroupVersionResource{Group: "amd.com", Version: "v1", Resource: "users"}

// SystemAdminRole matches SaFE's system-admin role. That role is not limited to listed workspaces.
const SystemAdminRole = identity.RoleSystemAdmin

// OwnerUser is the SaFE User data used when workspace SAR is off.
type OwnerUser struct {
	Found      bool
	Admin      bool
	Workspaces []string
}

// UserReader reads a SaFE User once. A missing User is Found=false with no error.
type UserReader interface {
	ReadUser(ctx context.Context, userID string) (OwnerUser, error)
}

// UserCRMembership reads users.amd.com objects named by user id.
type UserCRMembership struct {
	client dynamic.Interface
}

// NewUserCRMembership reads cluster-scoped User objects through client.
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

// isSystemAdmin reports whether spec.roles contains the system-admin role.
func isSystemAdmin(obj *unstructured.Unstructured) bool {
	roles, _, err := unstructured.NestedStringSlice(obj.Object, "spec", "roles")
	if err != nil {
		return false
	}
	return contains(roles, SystemAdminRole)
}

// ReadUser reads the User once. A read error other than not-found is returned unchanged.
func (m *UserCRMembership) ReadUser(ctx context.Context, userID string) (OwnerUser, error) {
	if m == nil || m.client == nil {
		return OwnerUser{}, opErr(http.StatusServiceUnavailable, "membership_unavailable", "User client is not configured")
	}
	obj, err := m.client.Resource(userGVR).Get(ctx, userID, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return OwnerUser{}, nil
	}
	if err != nil {
		return OwnerUser{}, err
	}
	u := OwnerUser{Found: true, Admin: isSystemAdmin(obj)}
	if u.Workspaces, err = listedWorkspaces(obj); err != nil {
		return OwnerUser{}, opWrap(http.StatusForbidden, "user_not_in_workspace", "workspace list is unreadable", err)
	}
	return u, nil
}

// allows rejects any workspace not listed on the User unless the User is a system admin.
func (u OwnerUser) allows(workspaces []string) error {
	if !u.Found {
		return opErr(http.StatusForbidden, "user_not_in_workspace", "user was not found")
	}
	if u.Admin {
		return nil
	}
	for _, ws := range workspaces {
		if !contains(u.Workspaces, ws) {
			return opErr(http.StatusForbidden, "user_not_in_workspace", ws)
		}
	}
	return nil
}

// ReadOwnerUser reads the SaFE User of userID. It returns nil with no error when no reader is configured.
func (s *Service) ReadOwnerUser(ctx context.Context, userID string) (*OwnerUser, error) {
	if s.users == nil || userID == "" {
		return nil, nil
	}
	u, err := s.users.ReadUser(ctx, userID)
	if err != nil {
		return nil, err
	}
	return &u, nil
}

// readUser reads the SaFE User for a membership decision. A missing reader or a read error is 503.
func (s *Service) readUser(ctx context.Context, userID string) (OwnerUser, error) {
	if s.users == nil {
		return OwnerUser{}, opErr(http.StatusServiceUnavailable, "membership_unavailable", "User client is not configured")
	}
	u, err := s.users.ReadUser(ctx, userID)
	if _, ok := err.(*OpError); ok {
		return OwnerUser{}, err
	}
	if err != nil {
		return OwnerUser{}, opWrap(http.StatusServiceUnavailable, "membership_unavailable", "user is temporarily unreadable", err)
	}
	return u, nil
}

// Introspector validates an identity provider key.
type Introspector interface {
	Introspect(ctx context.Context, key string) (identity.Token, error)
}

// Authorizer answers workspace and platform permission questions for an identity subject.
type Authorizer interface {
	CanUseWorkspace(ctx context.Context, sub string, groups []string, ws string) (bool, error)
	PlatformRole(ctx context.Context, sub string, groups []string) (string, error)
}

// WorkspaceLister lists the names of all workspaces.
type WorkspaceLister interface {
	ListWorkspaces(ctx context.Context) ([]string, error)
}

// ownerToken introspects a delegated platform key and requires its subject to be userID.
func (s *Service) ownerToken(ctx context.Context, platformKey, userID string) (identity.Token, error) {
	if s.identity == nil {
		return identity.Token{}, opErr(http.StatusServiceUnavailable, "identity_unavailable", "identity client is not configured")
	}
	tok, err := s.identity.Introspect(ctx, platformKey)
	if errors.Is(err, identity.ErrInactive) {
		return identity.Token{}, opErr(http.StatusForbidden, "platform_key_rejected", "platform key was rejected")
	}
	if err != nil {
		return identity.Token{}, opWrap(http.StatusServiceUnavailable, "identity_unavailable", "identity is temporarily unavailable", err)
	}
	if tok.Subject != userID {
		return identity.Token{}, opErr(http.StatusForbidden, "user_mismatch", "platform key user does not match owner.userId")
	}
	return tok, nil
}

// WorkspaceSAR reports whether workspace and platform permission are reviewed.
func (s *Service) WorkspaceSAR() bool {
	return s != nil && s.authz != nil
}

// canUse reports whether the subject may use workspace ws through workspace SAR. A review error is 503.
func (s *Service) canUse(ctx context.Context, sub string, groups []string, ws string) (bool, error) {
	if s.authz == nil {
		return false, opErr(http.StatusServiceUnavailable, "membership_unavailable", "authorization client is not configured")
	}
	ok, err := s.authz.CanUseWorkspace(ctx, sub, groups, ws)
	if err != nil {
		return false, opWrap(http.StatusServiceUnavailable, "membership_unavailable", "workspace permission is temporarily unreadable", err)
	}
	return ok, nil
}

// checkWorkspaces rejects any workspace the subject may not use. With workspace SAR
// off, the workspaces listed on the SaFE User decide.
func (s *Service) checkWorkspaces(ctx context.Context, sub string, groups []string, workspaces []string) error {
	if s.authz == nil {
		u, err := s.readUser(ctx, sub)
		if err != nil {
			return err
		}
		return u.allows(workspaces)
	}
	for _, ws := range workspaces {
		ok, err := s.canUse(ctx, sub, groups, ws)
		if err != nil {
			return err
		}
		if !ok {
			return opErr(http.StatusForbidden, "user_not_in_workspace", ws)
		}
	}
	return nil
}

// PlatformRole returns the platform role of the subject. A review error is 503.
func (s *Service) PlatformRole(ctx context.Context, sub string, groups []string) (string, error) {
	if s.authz == nil {
		return "", opErr(http.StatusServiceUnavailable, "membership_unavailable", "authorization client is not configured")
	}
	role, err := s.authz.PlatformRole(ctx, sub, groups)
	if err != nil {
		return "", opWrap(http.StatusServiceUnavailable, "membership_unavailable", "platform role is temporarily unreadable", err)
	}
	return role, nil
}

// ChecksGrantOwner reports whether a grant-key create must call CheckGrantOwner:
// workspace SAR reviews the owner, or the Workload assertion needs the owner's key.
func (s *Service) ChecksGrantOwner() bool {
	return s != nil && (s.authz != nil || s.attestWorkloads)
}

// CheckGrantOwner confirms that the sealed platform key of a grant still belongs
// to the grant owner and that the owner may use workspace. It returns the platform key.
func (s *Service) CheckGrantOwner(ctx context.Context, grantID, workspace string) (string, error) {
	g, err := s.get(ctx, grantID)
	if err != nil {
		return "", err
	}
	if g.Spec.PlatformKeyCiphertext == "" {
		return "", opErr(http.StatusForbidden, "platform_key_rejected", "grant holds no platform key")
	}
	if len(s.dataKey) == 0 {
		return "", opErr(http.StatusServiceUnavailable, "grant_data_key_missing", "GRANT_DATA_KEY is not configured")
	}
	plain, err := Open(s.dataKey, g.Spec.PlatformKeyCiphertext)
	if err != nil {
		return "", opWrap(http.StatusInternalServerError, "grant_unseal_failed", "platform key cannot be opened", err)
	}
	key := string(plain)
	tok, err := s.ownerToken(ctx, key, g.Spec.Owner.UserID)
	if err != nil {
		return "", err
	}
	if err := s.checkWorkspaces(ctx, tok.Subject, tok.Groups, []string{workspace}); err != nil {
		return "", err
	}
	return key, nil
}
