// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Package nsadmission decides which namespaces the Router and the Workload
// Manager serve, from a Namespace label selector.
//
// The selector uses the same syntax as `kubectl get ns -l` and is matched
// against a Namespace informer, so admitting a new namespace is a label on that
// namespace rather than an edit to this deployment. No selector means every
// namespace is admitted, which is the behaviour before this package existed.
//
// On the Router's /v1/namespaces/:namespace routes, a namespace that does not
// match is answered exactly like a CodeInterpreter that does not exist (404),
// before any session lookup, sandbox creation or proxying; a session whose
// sandbox lives in another namespace than the one the URL names gets the same
// 404. The Workload Manager applies the check to sandbox creation and to
// template create/get/update/delete. Not covered yet: the list endpoints and
// the routes keyed only by session ID (get/delete/recover a session, its
// policy and logs), which the static /v1/namespaces/ Ingress does not expose.
//
// The check fails closed: until the informer has synced, or when the cache
// cannot answer, every request gets 503. That is deliberately not 404 -- a 404
// tells a client the workspace does not exist, which it may cache or surface as
// a permanent error, while the condition is transient and retrying is correct.
// The Router's readiness probe reports not-ready over the same window, so in a
// normal rollout no traffic reaches a replica whose cache is cold.
package nsadmission

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/gin-gonic/gin"
	k8serrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	corelisters "k8s.io/client-go/listers/core/v1"
	"k8s.io/client-go/tools/cache"

	log "sigs.k8s.io/agent-sandbox/pkg/logx"
)

// EnvVar is the environment variable carrying the selector.
const EnvVar = "NAMESPACE_SELECTOR"

// Decision is the outcome of an admission check.
type Decision int

const (
	// Admitted means the namespace matches the selector (or no selector is set).
	Admitted Decision = iota
	// NotAdmitted means the namespace does not exist or does not match.
	NotAdmitted
	// Unavailable means the cache cannot answer yet; the caller must deny.
	Unavailable
)

func (d Decision) String() string {
	switch d {
	case Admitted:
		return "admitted"
	case NotAdmitted:
		return "not_admitted"
	default:
		return "unavailable"
	}
}

// Admitter answers whether a namespace is admitted. A nil *Admitter admits
// every namespace, so callers need no branch for the unconfigured case.
type Admitter struct {
	selector labels.Selector
	factory  informers.SharedInformerFactory
	informer cache.SharedIndexInformer
	lister   corelisters.NamespaceLister
}

// ParseSelector parses a label selector in kubectl -l syntax. An empty or
// all-whitespace string returns (nil, nil): no admission control.
func ParseSelector(s string) (labels.Selector, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil, nil
	}
	sel, err := labels.Parse(s)
	if err != nil {
		return nil, fmt.Errorf("invalid namespace selector %q: %w", s, err)
	}
	if sel.Empty() {
		return nil, fmt.Errorf("namespace selector %q selects every namespace; leave it empty instead", s)
	}
	return sel, nil
}

// New returns an Admitter for selector, or nil when selector is nil.
// The informer lists and watches only the namespaces the selector matches
// (server-side filtering), so the cache stays small however many namespaces
// the cluster holds. Call Start before serving.
func New(client kubernetes.Interface, selector labels.Selector) *Admitter {
	if selector == nil {
		return nil
	}
	sel := selector.String()
	factory := informers.NewSharedInformerFactoryWithOptions(client, 0,
		informers.WithTweakListOptions(func(o *metav1.ListOptions) {
			o.LabelSelector = sel
		}))
	nsInformer := factory.Core().V1().Namespaces()
	return &Admitter{
		selector: selector,
		factory:  factory,
		informer: nsInformer.Informer(),
		lister:   nsInformer.Lister(),
	}
}

// Start runs the informer until ctx is done. It does not wait for the sync:
// until then Admit returns Unavailable and Ready returns false.
func (a *Admitter) Start(ctx context.Context) {
	if a == nil {
		return
	}
	a.factory.Start(ctx.Done())
}

// Selector returns the configured selector as a string ("" when unset).
func (a *Admitter) Selector() string {
	if a == nil {
		return ""
	}
	return a.selector.String()
}

// Ready reports whether the cache can answer. Always true when unconfigured.
func (a *Admitter) Ready() bool {
	return a == nil || a.informer.HasSynced()
}

// Admit decides whether namespace is admitted.
func (a *Admitter) Admit(namespace string) Decision {
	if a == nil {
		return Admitted
	}
	if !a.informer.HasSynced() {
		return Unavailable
	}
	ns, err := a.lister.Get(namespace)
	if k8serrors.IsNotFound(err) {
		return NotAdmitted
	}
	if err != nil {
		return Unavailable
	}
	// The list is already filtered by the API server; matching again keeps the
	// decision correct even if a cached object predates a label change that the
	// watch has not delivered as a delete.
	if !a.selector.Matches(labels.Set(ns.Labels)) {
		return NotAdmitted
	}
	return Admitted
}

// Gate checks namespace and, when it is not admitted, writes the response and
// aborts the request. It returns true when the request may proceed.
//
// notFound is the body of the 404 and should be the same text the caller
// returns for an object that does not exist, so a non-admitted namespace is
// indistinguishable from an empty one.
func (a *Admitter) Gate(c *gin.Context, namespace, notFound string) bool {
	switch d := a.Admit(namespace); d {
	case Admitted:
		return true
	case NotAdmitted:
		log.Info("namespace.admission.denied", "namespace", namespace,
			"method", c.Request.Method, "path", c.FullPath())
		c.AbortWithStatusJSON(http.StatusNotFound, gin.H{"error": notFound})
		return false
	default:
		log.Warn("namespace.admission.unavailable", "namespace", namespace,
			"method", c.Request.Method, "path", c.FullPath())
		c.Header("Retry-After", "1")
		c.AbortWithStatusJSON(http.StatusServiceUnavailable, gin.H{
			"error": "namespace admission is not ready, retry later",
			"code":  "namespace_admission_unavailable",
		})
		return false
	}
}
