// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Package usercr answers workspace and platform permission from SaFE User objects.
package usercr

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"golang.org/x/sync/singleflight"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"

	"sigs.k8s.io/agent-sandbox/pkg/authz"
	"sigs.k8s.io/agent-sandbox/pkg/identity"
)

// UserGVR is the cluster-scoped SaFE User. Its name is the user id.
var UserGVR = schema.GroupVersionResource{Group: "amd.com", Version: "v1", Resource: "users"}

// User is the SaFE User data used for membership.
type User struct {
	Found      bool
	Admin      bool
	Workspaces []string
}

// Reader reads one SaFE User. A missing User is Found=false with no error.
type Reader interface {
	Read(ctx context.Context, userID string) (User, error)
}

// UserCR reads users.amd.com objects named by user id.
type UserCR struct {
	client dynamic.Interface
}

// NewUserCR reads cluster-scoped User objects through client.
func NewUserCR(client dynamic.Interface) *UserCR {
	return &UserCR{client: client}
}

// Read returns the User once. A missing object is Found=false. Any other read error is unavailable.
func (m *UserCR) Read(ctx context.Context, userID string) (User, error) {
	if m == nil || m.client == nil {
		return User{}, fmt.Errorf("%w: User client is not configured", authz.ErrUnavailable)
	}
	obj, err := m.client.Resource(UserGVR).Get(ctx, userID, metav1.GetOptions{})
	if apierrors.IsNotFound(err) {
		return User{}, nil
	}
	if err != nil {
		return User{}, fmt.Errorf("%w: %v", authz.ErrUnavailable, err)
	}
	u := User{Found: true, Admin: isSystemAdmin(obj)}
	listed, err := listedWorkspaces(obj)
	if err != nil {
		return User{}, fmt.Errorf("%w: %v", authz.ErrNotInWorkspace, err)
	}
	u.Workspaces = listed
	return u, nil
}

// listedWorkspaces reads spec.resources.workspaces. spec.resources.workspace is accepted when that key is absent.
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
	return contains(roles, identity.RoleSystemAdmin)
}

const (
	// userAllowTTL is how long a found User is reused.
	userAllowTTL = 30 * time.Second
	// userDenyTTL is how long a missing User is reused.
	userDenyTTL = 5 * time.Second
	// userCacheSize is the most subjects kept. A new one past this drops one entry.
	userCacheSize = 4096
	// userReadTimeout bounds one User read shared by concurrent callers.
	userReadTimeout = 5 * time.Second
)

// Authorizer decides workspace use from the token and the SaFE User.
type Authorizer struct {
	users   Reader
	mu      sync.Mutex
	entries identity.TTL[cachedUser]
	now     func() time.Time
	flight  singleflight.Group
}

type cachedUser struct {
	user User
	err  error
}

// Option changes how an Authorizer reads Users.
type Option func(*Authorizer)

// WithClock sets the clock used for cache expiry. Tests advance it past a TTL.
func WithClock(now func() time.Time) Option {
	return func(a *Authorizer) { a.now = now }
}

// New returns an authorizer that reads User objects through client.
func New(client dynamic.Interface) *Authorizer {
	return NewFromReader(NewUserCR(client))
}

// NewFromReader returns an authorizer that reads users from r.
func NewFromReader(r Reader, opts ...Option) *Authorizer {
	a := &Authorizer{users: r}
	for _, opt := range opts {
		opt(a)
	}
	return a
}

// clock is the time cache expiry uses.
func (a *Authorizer) clock() time.Time {
	if a.now != nil {
		return a.now()
	}
	return time.Now()
}

// read returns the User. A found User is reused for 30s and a missing User for 5s. A read
// that cannot reach the API server is not cached. Concurrent reads of one user share one call,
// and that call is not cancelled when the first request ends.
func (a *Authorizer) read(ctx context.Context, userID string) (User, error) {
	if a == nil || a.users == nil {
		return User{}, fmt.Errorf("%w: User client is not configured", authz.ErrUnavailable)
	}
	now := a.clock()
	a.mu.Lock()
	if e, ok := a.entries.Get(userID, now); ok {
		a.mu.Unlock()
		return e.user, e.err
	}
	a.mu.Unlock()
	v, err, _ := a.flight.Do(userID, func() (any, error) {
		rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), userReadTimeout)
		defer cancel()
		u, err := a.users.Read(rctx, userID)
		if err != nil && errors.Is(err, authz.ErrUnavailable) {
			return cachedUser{}, err
		}
		ttl := userAllowTTL
		if err != nil || !u.Found {
			ttl = userDenyTTL
		}
		item := cachedUser{user: u, err: err}
		a.mu.Lock()
		a.entries.Put(userID, item, now.Add(ttl), now, userCacheSize)
		a.mu.Unlock()
		return item, err
	})
	if err != nil {
		return User{}, err
	}
	return v.(cachedUser).user, v.(cachedUser).err
}

// CanUseAllWorkspaces reports whether the token or the User is a system admin.
func (a *Authorizer) CanUseAllWorkspaces(ctx context.Context, tok identity.Token) (bool, error) {
	if identity.PlatformRole(tok.Roles) == identity.RoleSystemAdmin {
		return true, nil
	}
	u, err := a.read(ctx, tok.Subject)
	if err != nil {
		return false, err
	}
	return u.Admin, nil
}

// CanUseWorkspace reports whether the subject may use ws. An empty name is rejected.
func (a *Authorizer) CanUseWorkspace(ctx context.Context, tok identity.Token, ws string) (bool, error) {
	if ws == "" {
		return false, authz.ErrEmptyWorkspace
	}
	if identity.PlatformRole(tok.Roles) == identity.RoleSystemAdmin {
		return true, nil
	}
	u, err := a.read(ctx, tok.Subject)
	if err != nil {
		return false, err
	}
	if u.Admin || (u.Found && contains(u.Workspaces, ws)) {
		return true, nil
	}
	return false, nil
}

// ChooseWorkspace returns the requested workspace, or the only listed one when none was requested.
// A system admin must name a workspace and may use any.
func (a *Authorizer) ChooseWorkspace(ctx context.Context, tok identity.Token, requested string) (string, error) {
	if identity.PlatformRole(tok.Roles) == identity.RoleSystemAdmin {
		if requested == "" {
			return "", authz.ErrWorkspaceRequired
		}
		return requested, nil
	}
	u, err := a.read(ctx, tok.Subject)
	if err != nil {
		return "", err
	}
	if u.Admin {
		if requested == "" {
			return "", authz.ErrWorkspaceRequired
		}
		return requested, nil
	}
	if requested != "" {
		if u.Found && contains(u.Workspaces, requested) {
			return requested, nil
		}
		return "", authz.ErrNotInWorkspace
	}
	if !u.Found {
		return "", authz.ErrNotInWorkspace
	}
	if len(u.Workspaces) != 1 || u.Workspaces[0] == "" {
		return "", authz.ErrWorkspaceRequired
	}
	return u.Workspaces[0], nil
}

// PlatformRole returns the token role. A User with the system-admin role upgrades it.
func (a *Authorizer) PlatformRole(ctx context.Context, tok identity.Token) (string, error) {
	role := identity.PlatformRole(tok.Roles)
	if role == identity.RoleSystemAdmin {
		return role, nil
	}
	u, err := a.read(ctx, tok.Subject)
	if err != nil {
		return "", err
	}
	if u.Admin {
		return identity.RoleSystemAdmin, nil
	}
	return role, nil
}

// CallerRole returns the platform role of an introspected caller.
func (a *Authorizer) CallerRole(ctx context.Context, tok identity.Token) (string, error) {
	return a.PlatformRole(ctx, tok)
}

// contains reports whether list holds want.
func contains(list []string, want string) bool {
	for _, item := range list {
		if item == want {
			return true
		}
	}
	return false
}
