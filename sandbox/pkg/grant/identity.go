// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import (
	"context"
	"errors"
	"net/http"

	"sigs.k8s.io/agent-sandbox/pkg/identity"
)

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

// canUse reports whether the subject may use workspace ws. A review error is 503.
// With workspace SAR off the question is not asked and the answer is allow.
func (s *Service) canUse(ctx context.Context, sub string, groups []string, ws string) (bool, error) {
	if s.authz == nil {
		return true, nil
	}
	ok, err := s.authz.CanUseWorkspace(ctx, sub, groups, ws)
	if err != nil {
		return false, opWrap(http.StatusServiceUnavailable, "membership_unavailable", "workspace permission is temporarily unreadable", err)
	}
	return ok, nil
}

// checkWorkspaces rejects any workspace the subject may not use.
func (s *Service) checkWorkspaces(ctx context.Context, sub string, groups []string, workspaces []string) error {
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
