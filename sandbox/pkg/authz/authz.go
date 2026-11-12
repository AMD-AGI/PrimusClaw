// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Package authz answers workspace and platform permission questions through
// Kubernetes SubjectAccessReview.
package authz

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"golang.org/x/sync/singleflight"
	authorizationv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	"sigs.k8s.io/agent-sandbox/pkg/identity"
	log "sigs.k8s.io/agent-sandbox/pkg/logx"
)

// reviews counts SubjectAccessReview outcomes. result=allow and result=deny are
// answers from the API. result=unavailable is a review that could not be completed.
var reviews = promauto.NewCounterVec(
	prometheus.CounterOpts{
		Name: "sandbox_authz_reviews_total",
		Help: "SubjectAccessReview outcomes by question (workspaces or sessions) and result (allow, deny, unavailable).",
	},
	[]string{"question", "result"},
)

// WorkspaceSAREnv turns workspace and platform SubjectAccessReview on. Unset or any
// value other than true leaves it off.
const WorkspaceSAREnv = "ENABLE_WORKSPACE_SAR"

// WorkspaceSARFromEnv reports whether ENABLE_WORKSPACE_SAR is true.
func WorkspaceSARFromEnv() bool {
	return os.Getenv(WorkspaceSAREnv) == "true"
}

const (
	allowTTL     = 30 * time.Second
	denyTTL      = 5 * time.Second
	maxCacheSize = 4096
	callTimeout  = 5 * time.Second

	// DefaultSubjectPrefix is prepended to identity users and groups in a review.
	DefaultSubjectPrefix = "primus:"
	// PrefixEnv names the environment variable that overrides DefaultSubjectPrefix.
	PrefixEnv = "RBAC_SUBJECT_PREFIX"
)

// ErrUnavailable means the review could not be answered. It is never a deny.
var ErrUnavailable = errors.New("authorization is unavailable")

// ErrEmptyWorkspace means the caller named no workspace. An empty name is not a review of every workspace.
var ErrEmptyWorkspace = errors.New("workspace name is empty")

// ErrWorkspaceRequired means the caller must set a workspace. It is not a denial of a named workspace.
var ErrWorkspaceRequired = errors.New("workspace required")

// ErrNotInWorkspace means the subject may not use the requested workspace.
var ErrNotInWorkspace = errors.New("user not in workspace")

// Reviewer creates one SubjectAccessReview.
type Reviewer interface {
	Create(ctx context.Context, review *authorizationv1.SubjectAccessReview, opts metav1.CreateOptions) (*authorizationv1.SubjectAccessReview, error)
}

// Client asks SubjectAccessReview questions for identity subjects. Allowed answers
// are cached for 30s and denied answers for 5s. Concurrent identical questions share one call.
type Client struct {
	reviewer Reviewer
	prefix   string
	now      func() time.Time
	group    singleflight.Group

	mu      sync.Mutex
	entries identity.TTL[bool]
}

// NewClient returns a client that prefixes users and groups with prefix.
func NewClient(reviewer Reviewer, prefix string) *Client {
	return &Client{reviewer: reviewer, prefix: prefix, now: time.Now}
}

// PrefixFromEnv returns RBAC_SUBJECT_PREFIX when set, else DefaultSubjectPrefix.
func PrefixFromEnv() string {
	if v, ok := os.LookupEnv(PrefixEnv); ok {
		return strings.TrimSpace(v)
	}
	return DefaultSubjectPrefix
}

// FromClientset returns a client backed by the clientset's SubjectAccessReview API.
// An empty subject prefix is refused, since identity subjects would then share the
// Kubernetes user and group namespace.
func FromClientset(clientset kubernetes.Interface) (*Client, error) {
	prefix := PrefixFromEnv()
	if prefix == "" {
		return nil, fmt.Errorf("%s must not be empty when %s=true", PrefixEnv, WorkspaceSAREnv)
	}
	return NewClient(clientset.AuthorizationV1().SubjectAccessReviews(), prefix), nil
}

// workspaceUse is the review for one named workspace. An empty name is not this review.
func workspaceUse(name string) authorizationv1.ResourceAttributes {
	return authorizationv1.ResourceAttributes{Group: "amd.com", Resource: "workspaces", Name: name, Verb: "use"}
}

// CanUseWorkspace reports whether the subject may use workspace ws.
// An empty name is rejected and is not a review of every workspace.
func (c *Client) CanUseWorkspace(ctx context.Context, tok identity.Token, ws string) (bool, error) {
	if ws == "" {
		return false, ErrEmptyWorkspace
	}
	return c.Allowed(ctx, tok.Subject, tok.Groups, workspaceUse(ws))
}

// CanUseAllWorkspaces reports whether the subject may use any workspace.
// It is the only review that leaves the workspace name empty.
func (c *Client) CanUseAllWorkspaces(ctx context.Context, tok identity.Token) (bool, error) {
	return c.Allowed(ctx, tok.Subject, tok.Groups, workspaceUse(""))
}

// ChooseWorkspace returns the requested workspace when the subject may use it.
// A missing request is workspace_required. This client does not list workspaces.
func (c *Client) ChooseWorkspace(ctx context.Context, tok identity.Token, requested string) (string, error) {
	if requested == "" {
		return "", ErrWorkspaceRequired
	}
	ok, err := c.CanUseWorkspace(ctx, tok, requested)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", ErrNotInWorkspace
	}
	return requested, nil
}

// PlatformRole returns system-admin when the subject may delete sessions,
// system-admin-readonly when it may list them, and default otherwise.
// The review uses tok.Groups. Token roles are not added as groups.
func (c *Client) PlatformRole(ctx context.Context, tok identity.Token) (string, error) {
	attrs := authorizationv1.ResourceAttributes{Group: "runtime.agent-sandbox.io", Resource: "sessions", Verb: "delete"}
	ok, err := c.Allowed(ctx, tok.Subject, tok.Groups, attrs)
	if err != nil {
		return "", err
	}
	if ok {
		return identity.RoleSystemAdmin, nil
	}
	attrs.Verb = "list"
	if ok, err = c.Allowed(ctx, tok.Subject, tok.Groups, attrs); err != nil {
		return "", err
	}
	if ok {
		return identity.RoleSystemAdminReadonly, nil
	}
	return identity.RoleDefault, nil
}

// Unavailable is the answer to a caller whose permission cannot be reviewed.
var Unavailable = identity.Rejection{
	Status:  http.StatusServiceUnavailable,
	Code:    "membership_unavailable",
	Message: "permission review is unavailable",
}

// CallerRole returns the platform role of an introspected caller. A nil client reads
// the role from the token, which is the answer while workspace SAR is off.
func (c *Client) CallerRole(ctx context.Context, tok identity.Token) (string, error) {
	if c == nil {
		return identity.PlatformRole(tok.Roles), nil
	}
	return c.PlatformRole(ctx, tok)
}

// Allowed reviews attrs for the prefixed subject and groups. An empty subject is denied.
func (c *Client) Allowed(ctx context.Context, sub string, groups []string, attrs authorizationv1.ResourceAttributes) (bool, error) {
	question := attrs.Resource
	if question == "" {
		question = "unknown"
	}
	if c == nil || c.reviewer == nil {
		observeReview(question, "unavailable", sub, ErrUnavailable)
		return false, fmt.Errorf("%w: client is not configured", ErrUnavailable)
	}
	if sub == "" {
		observeReview(question, "deny", sub, nil)
		return false, nil
	}
	spec := authorizationv1.SubjectAccessReviewSpec{User: c.prefix + sub, ResourceAttributes: &attrs}
	for _, g := range groups {
		if g != "" {
			spec.Groups = append(spec.Groups, c.prefix+g)
		}
	}
	sort.Strings(spec.Groups)
	key := cacheKey(spec)
	if allowed, ok := c.cached(key); ok {
		result := "deny"
		if allowed {
			result = "allow"
		}
		observeReview(question, result, sub, nil)
		return allowed, nil
	}
	v, err, _ := c.group.Do(key, func() (any, error) {
		rctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), callTimeout)
		defer cancel()
		out, err := c.reviewer.Create(rctx, &authorizationv1.SubjectAccessReview{Spec: spec}, metav1.CreateOptions{})
		if err != nil {
			return false, fmt.Errorf("%w: %v", ErrUnavailable, err)
		}
		c.store(key, out.Status.Allowed)
		return out.Status.Allowed, nil
	})
	if err != nil {
		observeReview(question, "unavailable", sub, err)
		return false, err
	}
	allowed := v.(bool)
	result := "deny"
	if allowed {
		result = "allow"
	}
	observeReview(question, result, sub, nil)
	return allowed, nil
}

// observeReview counts one review and logs a denial or a review that could not be completed.
func observeReview(question, result, sub string, err error) {
	reviews.WithLabelValues(question, result).Inc()
	switch result {
	case "unavailable":
		log.Warn("permission review failed", "question", question, "subject", sub, "error", err)
	case "deny":
		log.Debug("permission denied", "question", question, "subject", sub)
	}
}

// cacheKey hashes the reviewed user, groups, and attributes.
func cacheKey(spec authorizationv1.SubjectAccessReviewSpec) string {
	a := spec.ResourceAttributes
	h := sha256.New()
	for _, part := range []string{spec.User, strings.Join(spec.Groups, "\x01"), a.Group, a.Resource, a.Name, a.Verb} {
		h.Write([]byte(part))
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))
}

// cached returns a cached answer. The second result is false on a miss.
func (c *Client) cached(key string) (bool, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.entries.Get(key, c.now())
}

// store caches an answer. The map is the same bounded TTL map introspection uses.
func (c *Client) store(key string, allowed bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	ttl := denyTTL
	if allowed {
		ttl = allowTTL
	}
	c.entries.Put(key, allowed, now.Add(ttl), now, maxCacheSize)
}

// ResolveRole returns the platform role of tok. A nil source reads the token roles.
func ResolveRole(src RoleSource, ctx context.Context, tok identity.Token) (string, error) {
	if src == nil {
		return identity.PlatformRole(tok.Roles), nil
	}
	return src.CallerRole(ctx, tok)
}

// RoleSource resolves the platform role of an introspected caller.
type RoleSource interface {
	CallerRole(ctx context.Context, tok identity.Token) (string, error)
}
