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
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
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

// workspaceGVR is the cluster-scoped SaFE Workspace.
var workspaceGVR = schema.GroupVersionResource{Group: "amd.com", Version: "v1", Resource: "workspaces"}

// Reviewer creates one SubjectAccessReview.
type Reviewer interface {
	Create(ctx context.Context, review *authorizationv1.SubjectAccessReview, opts metav1.CreateOptions) (*authorizationv1.SubjectAccessReview, error)
}

type entry struct {
	allowed bool
	expires time.Time
}

// Client asks SubjectAccessReview questions for identity subjects. Allowed answers
// are cached for 30s and denied answers for 5s. Concurrent identical questions share one call.
type Client struct {
	reviewer Reviewer
	prefix   string
	now      func() time.Time
	group    singleflight.Group

	mu      sync.Mutex
	entries map[string]entry
}

// NewClient returns a client that prefixes users and groups with prefix.
func NewClient(reviewer Reviewer, prefix string) *Client {
	return &Client{reviewer: reviewer, prefix: prefix, now: time.Now, entries: map[string]entry{}}
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

// CanUseWorkspace reports whether the subject may use workspace ws.
func (c *Client) CanUseWorkspace(ctx context.Context, sub string, groups []string, ws string) (bool, error) {
	return c.Allowed(ctx, sub, groups, authorizationv1.ResourceAttributes{
		Group: "amd.com", Resource: "workspaces", Name: ws, Verb: "use",
	})
}

// PlatformRole returns system-admin when the subject may delete sessions,
// system-admin-readonly when it may list them, and default otherwise.
func (c *Client) PlatformRole(ctx context.Context, sub string, groups []string) (string, error) {
	attrs := authorizationv1.ResourceAttributes{Group: "runtime.agent-sandbox.io", Resource: "sessions", Verb: "delete"}
	ok, err := c.Allowed(ctx, sub, groups, attrs)
	if err != nil {
		return "", err
	}
	if ok {
		return identity.RoleSystemAdmin, nil
	}
	attrs.Verb = "list"
	if ok, err = c.Allowed(ctx, sub, groups, attrs); err != nil {
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
	return c.PlatformRole(ctx, tok.Subject, tok.Groups)
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
	e, ok := c.entries[key]
	if !ok {
		return false, false
	}
	if !c.now().Before(e.expires) {
		delete(c.entries, key)
		return false, false
	}
	return e.allowed, true
}

// store caches an answer, evicting expired entries, then one entry, when full.
func (c *Client) store(key string, allowed bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	ttl := denyTTL
	if allowed {
		ttl = allowTTL
	}
	if _, ok := c.entries[key]; !ok && len(c.entries) >= maxCacheSize {
		for k, old := range c.entries {
			if !now.Before(old.expires) {
				delete(c.entries, k)
			}
		}
		if len(c.entries) >= maxCacheSize {
			for k := range c.entries {
				delete(c.entries, k)
				break
			}
		}
	}
	c.entries[key] = entry{allowed: allowed, expires: now.Add(ttl)}
}

// WorkspaceLister lists SaFE Workspace names.
type WorkspaceLister struct {
	client dynamic.Interface
}

// NewWorkspaceLister reads cluster-scoped amd.com/v1 Workspaces.
func NewWorkspaceLister(client dynamic.Interface) *WorkspaceLister {
	return &WorkspaceLister{client: client}
}

// ListWorkspaces returns the names of all Workspaces. A read error wraps ErrUnavailable.
func (l *WorkspaceLister) ListWorkspaces(ctx context.Context) ([]string, error) {
	if l == nil || l.client == nil {
		return nil, fmt.Errorf("%w: workspace client is not configured", ErrUnavailable)
	}
	list, err := l.client.Resource(workspaceGVR).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("%w: list workspaces: %v", ErrUnavailable, err)
	}
	names := make([]string, 0, len(list.Items))
	for _, item := range list.Items {
		names = append(names, item.GetName())
	}
	sort.Strings(names)
	return names, nil
}
