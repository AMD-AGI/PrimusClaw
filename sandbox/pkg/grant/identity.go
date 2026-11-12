// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import (
	"context"
	"errors"
	"net/http"

	"sigs.k8s.io/agent-sandbox/pkg/authz"
	"sigs.k8s.io/agent-sandbox/pkg/identity"
)

// Introspector validates an identity provider key.
type Introspector interface {
	Introspect(ctx context.Context, key string) (identity.Token, error)
}

// Authorizer answers workspace and platform permission questions for an identity subject.
type Authorizer interface {
	CanUseWorkspace(ctx context.Context, tok identity.Token, ws string) (bool, error)
	CanUseAllWorkspaces(ctx context.Context, tok identity.Token) (bool, error)
	PlatformRole(ctx context.Context, tok identity.Token) (string, error)
	ChooseWorkspace(ctx context.Context, tok identity.Token, requested string) (string, error)
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

// checkWorkspaces rejects any workspace the subject may not use.
func (s *Service) checkWorkspaces(ctx context.Context, tok identity.Token, workspaces []string) error {
	if s.authz == nil {
		return opErr(http.StatusServiceUnavailable, "membership_unavailable", "authorization client is not configured")
	}
	for _, ws := range workspaces {
		if ws == "" {
			return opErr(http.StatusBadRequest, "invalid_grant", "workspace name is empty")
		}
		ok, err := s.authz.CanUseWorkspace(ctx, tok, ws)
		if err != nil {
			return membershipErr(err, ws)
		}
		if !ok {
			return opErr(http.StatusForbidden, "user_not_in_workspace", ws)
		}
	}
	return nil
}

// membershipErr maps an authorizer error onto a grant error. A nil error stays nil.
func membershipErr(err error, ws string) error {
	if err == nil {
		return nil
	}
	switch {
	case errors.Is(err, authz.ErrWorkspaceRequired):
		return opErr(http.StatusBadRequest, "workspace_required", "set metadata agent-sandbox.io/workspace")
	case errors.Is(err, authz.ErrNotInWorkspace):
		if ws == "" {
			ws = "user may not use any workspace"
		}
		return opErr(http.StatusForbidden, "user_not_in_workspace", ws)
	case errors.Is(err, authz.ErrEmptyWorkspace):
		return opErr(http.StatusBadRequest, "invalid_grant", "workspace name is empty")
	default:
		return opWrap(http.StatusServiceUnavailable, "membership_unavailable", "workspace permission is temporarily unreadable", err)
	}
}

// PlatformRole returns the platform role of the subject. With no authorizer it reads the token roles.
func (s *Service) PlatformRole(ctx context.Context, tok identity.Token) (string, error) {
	if s.authz == nil {
		return identity.PlatformRole(tok.Roles), nil
	}
	role, err := s.authz.PlatformRole(ctx, tok)
	if err != nil {
		return "", opWrap(http.StatusServiceUnavailable, "membership_unavailable", "platform role is temporarily unreadable", err)
	}
	return role, nil
}

// ChecksGrantOwner reports whether a grant-key create must call CheckGrantOwner.
// That is workspace SAR, which reviews the owner, or a Workload assertion, which needs the owner's key.
func (s *Service) ChecksGrantOwner() bool {
	return s != nil && (s.reviewOwner || s.attestWorkloads)
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
	if err := s.checkWorkspaces(ctx, tok, []string{workspace}); err != nil {
		return "", err
	}
	return key, nil
}
