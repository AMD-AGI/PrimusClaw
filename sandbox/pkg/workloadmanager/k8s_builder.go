// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	k8serrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
	k8sruntime "k8s.io/apimachinery/pkg/runtime"
	schemepkg "k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	"k8s.io/apimachinery/pkg/util/wait"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	listersv1 "k8s.io/client-go/listers/core/v1"
	"k8s.io/client-go/rest"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	sandboxv1alpha1 "sigs.k8s.io/agent-sandbox/api/v1alpha1"
	extensionsv1alpha1 "sigs.k8s.io/agent-sandbox/extensions/api/v1alpha1"
	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/store"
)

var _ = schemepkg.GroupVersion{} // ensure import used

// ErrTemplateNotFound is returned by CreateSandbox specifically when the
// CodeInterpreter template itself does not exist. Callers must use errors.Is
// to distinguish this from unrelated "not found" strings that can appear
// inside errors from later stages (e.g. image pull failures, Pod lookups),
// since those must NOT be reported to API callers as "template not found".
var ErrTemplateNotFound = errors.New("code interpreter template not found")

// SandboxResult holds the result of creating a K8s sandbox.
type SandboxResult struct {
	SandboxName string
	Namespace   string
	PodIP       string
	PodPort     int
	// Kind is "Sandbox" or "SandboxClaim" — used by GC to choose deletion method.
	Kind string
	// MaxSessionDuration is read from CodeInterpreter.spec.maxSessionDuration.
	// WM uses this to set SandboxInfo.ExpiresAt (hard upper bound on session lifetime).
	MaxSessionDuration time.Duration
	// Policy fields propagated from CodeInterpreter spec to Redis SandboxInfo.
	RuntimePolicy        string
	AllowedEgressHosts   []string
	AllowedInternalHosts []string
}

const (
	// sandboxNameLabelKey is the label key set on Sandbox objects and their Pods.
	sandboxNameLabelKey = "runtime.agent-sandbox.io/sandbox-name"

	// idleTimeoutAnnotationKey stores per-sandbox idle timeout on the Sandbox object.
	// Read by Agentd for per-sandbox GC.
	idleTimeoutAnnotationKey = "runtime.agent-sandbox.io/idle-timeout"

	// userIDLabelKey stores the verified user ID as a Label on the Sandbox object.
	// Labels support K8s selector queries (e.g. kubectl get sandboxes -l user.id=uid-123).
	// Following SaFE convention: userId → Label (no special chars, queryable).
	userIDLabelKey = "runtime.agent-sandbox.io/user.id"

	// userNameAnnotationKey stores the user display name as an Annotation.
	// Annotations have no character restrictions — safe for names with commas (e.g. "Last, First").
	// Following SaFE convention: userName → Annotation (may contain special chars).
	userNameAnnotationKey = "runtime.agent-sandbox.io/user.name"

	// sessionIDAnnotationKey stores the session ID on the Sandbox object.
	// This enables session recovery from K8s when Redis data is lost (e.g. Redis restart).
	// The Router can ask WM to look up a Sandbox by this annotation to rebuild the
	// session→pod mapping without requiring Redis persistence.
	sessionIDAnnotationKey = "runtime.agent-sandbox.io/session-id"
)

// UserIdentity holds the authenticated user info to stamp onto Sandbox resources.
// Empty fields are omitted (auth disabled or info not available).
type UserIdentity struct {
	UserID   string
	UserName string
}

// SessionIDIndexField names the field index that resolves a session id to its
// Sandbox. Registered with the manager's cache by IndexSandboxesBySessionID.
const SessionIDIndexField = "metadata.annotations.session-id"

// K8sSandboxCreator handles real K8s sandbox creation/deletion.
type K8sSandboxCreator struct {
	client     ctrlclient.Client
	kubeClient kubernetes.Interface // standard clientset for pod logs / exec
	informers  *CRDInformers        // local cache for CRD reads
	reconciler *SandboxReconciler   // event-driven Pod readiness notification
	podLister  listersv1.PodLister  // Pod lister backed by SharedInformer — zero API Server calls
	podStarted bool                 // whether pod informer factory has been started

	// cachedReader serves session-id lookups from the manager's cache. Read-only
	// and optional: everything else still goes through client, so a stale read
	// cannot reach a write path.
	cachedReader ctrlclient.Reader
}

// IndexSandboxesBySessionID registers the session-id index on a manager's cache.
// Must be called before the manager starts.
//
// Without it, resolving a session id means listing every Sandbox and filtering in
// Go. That runs on the recovery path, which the keepalive poll reaches once per
// session per minute whenever the store cannot answer -- so a store outage turns
// into a full List per session per minute against the API server. The index
// answers the same question from cache in one lookup.
func IndexSandboxesBySessionID(ctx context.Context, indexer ctrlclient.FieldIndexer) error {
	return indexer.IndexField(ctx, &sandboxv1alpha1.Sandbox{}, SessionIDIndexField,
		func(obj ctrlclient.Object) []string {
			sb, ok := obj.(*sandboxv1alpha1.Sandbox)
			if !ok {
				return nil
			}
			if id := sb.Annotations[sessionIDAnnotationKey]; id != "" {
				return []string{id}
			}
			return nil
		})
}

// NewK8sSandboxCreator creates a K8sSandboxCreator from the given rest.Config.
func NewK8sSandboxCreator(cfg *rest.Config) (*K8sSandboxCreator, error) {
	scheme := k8sruntime.NewScheme()
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
	utilruntime.Must(sandboxv1alpha1.AddToScheme(scheme))
	utilruntime.Must(extensionsv1alpha1.AddToScheme(scheme))
	utilruntime.Must(runtimev1alpha1.AddToScheme(scheme))

	c, err := ctrlclient.New(cfg, ctrlclient.Options{Scheme: scheme})
	if err != nil {
		return nil, fmt.Errorf("create controller-runtime client: %w", err)
	}

	// Create PodLister backed by SharedInformer for cache-based Pod IP lookup
	clientset, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		return nil, fmt.Errorf("create clientset for pod lister: %w", err)
	}
	factory := informers.NewSharedInformerFactory(clientset, 0)
	podLister := factory.Core().V1().Pods().Lister()

	creator := &K8sSandboxCreator{client: c, kubeClient: clientset, podLister: podLister}

	// Start and sync Pod informer
	stopCh := make(chan struct{})
	factory.Start(stopCh)
	factory.WaitForCacheSync(stopCh)

	return creator, nil
}

// WithInformers attaches the CRD Informer cache.
func (c *K8sSandboxCreator) WithInformers(inf *CRDInformers) *K8sSandboxCreator {
	c.informers = inf
	return c
}

// WithCachedReader attaches a cache-backed reader for session-id lookups. Pair it
// with IndexSandboxesBySessionID on the same cache; without the index the lookup
// errors and the caller falls back to listing.
func (c *K8sSandboxCreator) WithCachedReader(r ctrlclient.Reader) *K8sSandboxCreator {
	c.cachedReader = r
	return c
}

// WithReconciler attaches the SandboxReconciler for event-driven Pod readiness.
func (c *K8sSandboxCreator) WithReconciler(r *SandboxReconciler) *K8sSandboxCreator {
	c.reconciler = r
	return c
}

// GetSandboxPodIP returns the Pod IP for the given Sandbox.
// Uses 3-layer lookup:
//  1. annotation agents.x-k8s.io/pod-name → PodLister (zero API Server calls)
//  2. label runtime.agent-sandbox.io/sandbox-name → PodLister
//  3. ownerReferences filter
func (c *K8sSandboxCreator) GetSandboxPodIP(ctx context.Context, namespace, sandboxName, podName string) (string, error) {
	// Layer 1: try by annotation-provided podName from PodLister cache
	if podName != "" && c.podLister != nil {
		pod, err := c.podLister.Pods(namespace).Get(podName)
		if err == nil && pod != nil {
			if ip, err := validatePodIP(pod); err == nil {
				return ip, nil
			}
		}
	}

	// Layer 2: list by sandbox-name label from PodLister cache
	if c.podLister != nil {
		pods, err := c.podLister.Pods(namespace).List(
			labels.SelectorFromSet(map[string]string{sandboxNameLabelKey: sandboxName}),
		)
		if err == nil {
			// Layer 3: filter by ownerReference → Sandbox
			for _, pod := range pods {
				for _, ref := range pod.OwnerReferences {
					if ref.Kind == "Sandbox" && ref.Name == sandboxName {
						if ip, err := validatePodIP(pod); err == nil {
							return ip, nil
						}
					}
				}
			}
		}
	}

	// Fallback: direct API Server call
	pod := &corev1.Pod{}
	lookupName := sandboxName
	if podName != "" {
		lookupName = podName
	}
	if err := c.client.Get(ctx, types.NamespacedName{Name: lookupName, Namespace: namespace}, pod); err != nil {
		return "", fmt.Errorf("get pod %s/%s: %w", namespace, lookupName, err)
	}
	return validatePodIP(pod)
}

// validatePodIP checks if a Pod is Running and has an IP assigned.
func validatePodIP(pod *corev1.Pod) (string, error) {
	if pod.Status.Phase != corev1.PodRunning {
		return "", fmt.Errorf("pod %s not running (phase: %s)", pod.Name, pod.Status.Phase)
	}
	if pod.Status.PodIP == "" {
		return "", fmt.Errorf("pod %s has no IP yet", pod.Name)
	}
	return pod.Status.PodIP, nil
}

// CreateSandbox creates a Sandbox (via SandboxClaim if WarmPool is configured)
// and waits for the Pod to be Running, returning its IP.
// Resource configuration is read from the CodeInterpreter template.
// Safe parameters can be overridden via the overrides argument.
func (c *K8sSandboxCreator) CreateSandbox(
	ctx context.Context,
	sessionID string,
	ciName string,
	namespace string,
	user *UserIdentity,
	overrides *SandboxOverrides,
) (*SandboxResult, error) {
	// Look up CodeInterpreter
	ci := &runtimev1alpha1.CodeInterpreter{}
	if err := c.client.Get(ctx,
		types.NamespacedName{Name: ciName, Namespace: namespace}, ci); err != nil {
		if k8serrors.IsNotFound(err) {
			return nil, fmt.Errorf("%w: CodeInterpreter %q not found in namespace %q", ErrTemplateNotFound, ciName, namespace)
		}
		return nil, fmt.Errorf("get CodeInterpreter: %w", err)
	}

	// sandbox name = "<ciName>-<8 random lowercase alphanumeric chars>"
	// Note: CodeInterpreter names must NOT contain dots (e.g. use "python-311-runc"
	// instead of "python-3.11-runc") to satisfy DNS-1035 Service naming rules.
	sandboxName := ciName + "-" + randString(8)

	var result *SandboxResult
	var err error
	if ci.Spec.WarmPoolSize != nil && *ci.Spec.WarmPoolSize > 0 {
		result, err = c.createViaClaim(ctx, ci, sandboxName, sessionID, user, overrides)
	} else {
		result, err = c.createDirect(ctx, ci, sandboxName, namespace, sessionID, user, overrides)
	}
	if err != nil {
		return nil, err
	}

	// Propagate maxSessionDuration → SandboxResult → Redis ExpiresAt.
	// Priority: user override > template default > DefaultMaxSessionDuration (24h).
	// No hard cap — users can request lifetimes longer than 24h.
	if overrides != nil && overrides.MaxSessionDuration != "" {
		if userDur, err := time.ParseDuration(overrides.MaxSessionDuration); err == nil && userDur > 0 {
			result.MaxSessionDuration = userDur
		}
	} else if ci.Spec.MaxSessionDuration != nil && ci.Spec.MaxSessionDuration.Duration > 0 {
		result.MaxSessionDuration = ci.Spec.MaxSessionDuration.Duration
	}
	if result.MaxSessionDuration <= 0 {
		result.MaxSessionDuration = DefaultMaxSessionDuration
	}

	// Propagate egress policy from CodeInterpreter spec → SandboxResult → Redis SandboxInfo.
	result.RuntimePolicy = ci.Spec.RuntimePolicy
	if result.RuntimePolicy == "" {
		result.RuntimePolicy = "agent-default"
	}
	result.AllowedEgressHosts = ci.Spec.AllowedEgressHosts
	result.AllowedInternalHosts = ci.Spec.AllowedInternalHosts

	return result, nil
}

// createDirect creates a Sandbox directly from the CodeInterpreter template.
func (c *K8sSandboxCreator) createDirect(ctx context.Context, ci *runtimev1alpha1.CodeInterpreter, sandboxName, namespace, sessionID string, user *UserIdentity, overrides *SandboxOverrides) (*SandboxResult, error) {
	r := &CodeInterpreterReconciler{Client: c.client}
	podTemplate := r.buildPodTemplate(ci)

	// Determine ShutdownTime from template; fall back to DefaultMaxSessionDuration
	// when the template leaves it unset. User overrides are merged later in applyOverrides.
	sessionDur := DefaultMaxSessionDuration
	if ci.Spec.MaxSessionDuration != nil && ci.Spec.MaxSessionDuration.Duration > 0 {
		sessionDur = ci.Spec.MaxSessionDuration.Duration
	}
	st := shutdownTimeFromDuration(sessionDur)
	shutdownTime := &st

	// Add sandbox-name label for Pod lookup via label selector.
	if podTemplate.ObjectMeta.Labels == nil {
		podTemplate.ObjectMeta.Labels = make(map[string]string)
	}
	podTemplate.ObjectMeta.Labels[sandboxNameLabelKey] = sandboxName

	// Build annotations + labels — following SaFE convention:
	//   userId  → Label  (queryable via selector, no special chars)
	//   userName → Annotation (may contain commas, no char restrictions)
	//   sessionId → Annotation (enables session recovery from K8s when Redis data is lost)
	annotations := map[string]string{
		sessionIDAnnotationKey: sessionID,
	}
	if podTemplate.ObjectMeta.Annotations == nil {
		podTemplate.ObjectMeta.Annotations = make(map[string]string)
	}
	podTemplate.ObjectMeta.Annotations[sessionIDAnnotationKey] = sessionID
	sandboxLabels := map[string]string{
		sandboxNameLabelKey: sandboxName,
	}
	if ci.Spec.SessionTimeout != nil && ci.Spec.SessionTimeout.Duration > 0 {
		annotations[idleTimeoutAnnotationKey] = ci.Spec.SessionTimeout.Duration.String()
	}
	if user != nil {
		if user.UserID != "" {
			sandboxLabels[userIDLabelKey] = user.UserID
		}
		if user.UserName != "" {
			annotations[userNameAnnotationKey] = user.UserName
		}
	}

	// Propagate user identity to PodTemplate so the Pod itself also carries it.
	if user != nil && user.UserID != "" {
		podTemplate.ObjectMeta.Labels[userIDLabelKey] = user.UserID
		if user.UserName != "" {
			if podTemplate.ObjectMeta.Annotations == nil {
				podTemplate.ObjectMeta.Annotations = make(map[string]string)
			}
			podTemplate.ObjectMeta.Annotations[userNameAnnotationKey] = user.UserName
		}
	}

	// Apply user overrides (safe parameters only)
	applyOverrides(overrides, ci, &podTemplate, sandboxLabels, annotations, &shutdownTime)

	sandbox := &sandboxv1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{
			Name:        sandboxName,
			Namespace:   namespace,
			Labels:      sandboxLabels,
			Annotations: annotations,
		},
		Spec: sandboxv1alpha1.SandboxSpec{
			PodTemplate: podTemplate,
			Lifecycle: sandboxv1alpha1.Lifecycle{
				ShutdownTime: shutdownTime,
			},
		},
	}

	if err := c.client.Create(ctx, sandbox); err != nil {
		return nil, fmt.Errorf("create Sandbox: %w", err)
	}

	podIP, err := c.waitForSandboxPodRunning(ctx, sandboxName, namespace)
	if err != nil {
		return nil, err
	}

	// After Pod is "Running", verify it's truly healthy (all containers ready).
	// This catches cases where the main container starts but the `run` step fails
	// shortly after — without this check, we'd return 200 for a broken sandbox.
	if err := c.waitForPodHealthy(ctx, sandboxName, namespace, 30*time.Second); err != nil {
		return nil, err
	}

	return &SandboxResult{SandboxName: sandboxName, Namespace: namespace, PodIP: podIP, PodPort: 8080, Kind: "Sandbox"}, nil
}

// createViaClaim creates a SandboxClaim to use the WarmPool.
//  1. Register watcher for sandboxName BEFORE creating the claim — so we never miss the notification.
//  2. SandboxClaim controller creates a Sandbox with Name = SandboxClaim.Name (= sandboxName).
//  3. The SandboxClaim controller adopts a warm Pod (sets the agents.x-k8s.io/pod-name annotation).
//  4. SandboxReconciler fires when the Sandbox reaches Ready state → we get ServiceFQDN.
//
// How long a rollback gets once the request it belongs to is already over.
// Generous: it is deleting three objects, and the alternative to it finishing
// is a Pod held out of the pool until its absolute deadline.
const claimRollbackTimeout = 30 * time.Second

// applyClaimMetadataWithRetry gives the patch a few goes before giving up on
// the whole claim.
//
// The failures worth surviving here are the cheap ones -- a conflict with the
// controller that just created the object, an API server having a moment -- and
// they are gone by the next attempt. Bounded because the alternative to failing
// is worse than failing: every attempt is holding a Pod that came out of the
// warm pool.
func applyClaimMetadataWithRetry(
	ctx context.Context,
	c ctrlclient.Client,
	sandbox *sandboxv1alpha1.Sandbox,
	labels map[string]string,
	annotations map[string]string,
) error {
	const attempts = 3
	var err error
	for i := 0; i < attempts; i++ {
		if err = applyClaimMetadata(ctx, c, sandbox, labels, annotations); err == nil {
			return nil
		}
		if i < attempts-1 {
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(time.Duration(i+1) * 200 * time.Millisecond):
			}
		}
	}
	return err
}

// applyClaimMetadata writes the labels and annotations a warm-pool claim needs
// onto the Sandbox the pool handed over.
//
// The error is returned, not discarded. Everything in this patch is load-bearing
// on a pod that already exists: the session-id annotation is how a session is
// recovered when the store is lost, the idle-timeout annotation is the only
// place a configured lifetime lands on a claim, and the user label is how the
// sandbox is attributed. Swallowing a failure returned a sandbox that looks
// created and quietly has none of them -- the caller's lifetime silently
// replaced by the controller default, with nothing outside to tell from.
// Failing the claim is recoverable; a claim that half-succeeded is not.
func applyClaimMetadata(
	ctx context.Context,
	c ctrlclient.Client,
	sandbox *sandboxv1alpha1.Sandbox,
	labels map[string]string,
	annotations map[string]string,
) error {
	if len(labels) == 0 && len(annotations) == 0 {
		return nil
	}
	patchMeta := map[string]interface{}{}
	if len(labels) > 0 {
		patchMeta["labels"] = labels
	}
	if len(annotations) > 0 {
		patchMeta["annotations"] = annotations
	}
	metaJSON, err := json.Marshal(map[string]interface{}{"metadata": patchMeta})
	if err != nil {
		return fmt.Errorf("marshal metadata patch: %w", err)
	}
	if err := c.Patch(ctx, sandbox,
		ctrlclient.RawPatch(types.MergePatchType, metaJSON)); err != nil {
		return fmt.Errorf("patch metadata: %w", err)
	}
	return nil
}

func (c *K8sSandboxCreator) createViaClaim(ctx context.Context, ci *runtimev1alpha1.CodeInterpreter, sandboxName string, sessionID string, user *UserIdentity, overrides *SandboxOverrides) (*SandboxResult, error) {
	namespace := ci.Namespace

	// CRITICAL: register watcher BEFORE creating the SandboxClaim.
	// If we register after creation, the Sandbox may reach Ready state while we are
	// between creating the claim and registering the watcher — the notification would
	// be lost and we'd block until the 2-minute timeout.
	var resultChan <-chan SandboxStatusUpdate
	if c.reconciler != nil {
		resultChan = c.reconciler.WatchSandboxOnce(ctx, namespace, sandboxName)
		defer c.reconciler.UnWatchSandbox(namespace, sandboxName)
	}

	// Determine effective maxSessionDuration: user override > template default >
	// DefaultMaxSessionDuration (24h). No hard cap — longer values pass through as-is.
	var lifecycle *extensionsv1alpha1.Lifecycle
	sessionDur := time.Duration(0)
	if ci.Spec.MaxSessionDuration != nil && ci.Spec.MaxSessionDuration.Duration > 0 {
		sessionDur = ci.Spec.MaxSessionDuration.Duration
	}
	if overrides != nil && overrides.MaxSessionDuration != "" {
		if userDur, err := time.ParseDuration(overrides.MaxSessionDuration); err == nil && userDur > 0 {
			sessionDur = userDur
		}
	}
	if sessionDur <= 0 {
		sessionDur = DefaultMaxSessionDuration
	}
	st := shutdownTimeFromDuration(sessionDur)
	policy := extensionsv1alpha1.ShutdownPolicyDelete
	lifecycle = &extensionsv1alpha1.Lifecycle{
		ShutdownTime:   &st,
		ShutdownPolicy: policy,
	}

	// Build labels + annotations for the SandboxClaim — following SaFE convention.
	// sessionID is always written for session recovery from K8s when Redis data is lost.
	claimLabels := map[string]string{}
	claimAnnotations := map[string]string{
		sessionIDAnnotationKey: sessionID,
	}
	if user != nil {
		if user.UserID != "" {
			claimLabels[userIDLabelKey] = user.UserID
		}
		if user.UserName != "" {
			claimAnnotations[userNameAnnotationKey] = user.UserName
		}
	}

	claim := &extensionsv1alpha1.SandboxClaim{
		ObjectMeta: metav1.ObjectMeta{Name: sandboxName, Namespace: namespace, Labels: claimLabels, Annotations: claimAnnotations},
		Spec: extensionsv1alpha1.SandboxClaimSpec{
			TemplateRef: extensionsv1alpha1.SandboxTemplateRef{Name: ci.Name},
			Lifecycle:   lifecycle,
		},
	}
	if err := c.client.Create(ctx, claim); err != nil {
		return nil, fmt.Errorf("create SandboxClaim: %w", err)
	}

	// Wait for the Sandbox (name = sandboxName = claim name) to reach Ready state.
	timeout := 10 * time.Minute
	waitCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	if resultChan != nil {
		// Periodically check for pod failure while waiting for Ready notification.
		failCheckTicker := time.NewTicker(3 * time.Second)
		defer failCheckTicker.Stop()

		for {
			select {
			case update := <-resultChan:
				failCheckTicker.Stop()
				createdSandbox := update.Sandbox
				if createdSandbox == nil {
					return nil, fmt.Errorf("sandbox reconciler returned nil sandbox for %s/%s", namespace, sandboxName)
				}
				// Patch labels + annotations onto the Sandbox created by WarmPool controller:
				// - session-id annotation: enables session recovery from K8s when Redis is lost
				// - idle-timeout annotation: for Agentd per-sandbox GC
				// - user.id label: queryable user identity (SaFE convention)
				// - user.name annotation: display name with possible special chars
				patchLabels := map[string]string{}
				patchAnnotations := map[string]string{
					sessionIDAnnotationKey: sessionID,
				}
				// User override takes precedence over template default.
				if overrides != nil && overrides.SessionTimeout != "" {
					if userDur, err := time.ParseDuration(overrides.SessionTimeout); err == nil && userDur > 0 {
						patchAnnotations[idleTimeoutAnnotationKey] = userDur.String()
					}
				} else if ci.Spec.SessionTimeout != nil && ci.Spec.SessionTimeout.Duration > 0 {
					patchAnnotations[idleTimeoutAnnotationKey] = ci.Spec.SessionTimeout.Duration.String()
				}
				if user != nil {
					if user.UserID != "" {
						patchLabels[userIDLabelKey] = user.UserID
					}
					if user.UserName != "" {
						patchAnnotations[userNameAnnotationKey] = user.UserName
					}
				}
				// Retried, then rolled back. Returning straight away left the
				// Claim, the Sandbox and a Pod already taken out of the pool
				// behind -- the caller only clears its own placeholder -- so a
				// client retry claimed a second Pod and the first sat there until
				// its absolute deadline. A patch is a small write against an
				// object that already exists, so a couple of attempts covers the
				// conflicts and blips this is actually seeing; past that the claim
				// did not happen and should not look like it half did.
				if err := applyClaimMetadataWithRetry(waitCtx, c.client, createdSandbox,
					patchLabels, patchAnnotations); err != nil {
					// Not on ctx. The usual way this patch fails is the client
					// giving up, and that cancels ctx -- so a rollback riding it
					// is cancelled before it deletes anything, in precisely the
					// case it exists for. Detached, with its own deadline so a
					// wedged API server cannot hold the request open either.
					rbCtx, rbCancel := context.WithTimeout(
						context.WithoutCancel(ctx), claimRollbackTimeout)
					rbErr := c.DeleteSandboxClaim(rbCtx, &store.SandboxInfo{
						Namespace:   namespace,
						SandboxName: sandboxName,
					})
					rbCancel()
					if rbErr != nil {
						slog.Error("warm-pool claim rollback failed; pod may be held until its deadline",
							"namespace", namespace, "sandbox", sandboxName, "error", rbErr)
					}
					return nil, fmt.Errorf("warm-pool sandbox %s/%s: %w", namespace, sandboxName, err)
				}
				if ci.Spec.AuthMode != runtimev1alpha1.AuthModeNone {
					podName := createdSandbox.Annotations["agents.x-k8s.io/pod-name"]
					if podName == "" {
						return nil, fmt.Errorf("warm-pool sandbox %s/%s has no adopted pod identity", namespace, sandboxName)
					}
					pod := &corev1.Pod{}
					if err := c.client.Get(waitCtx, types.NamespacedName{
						Namespace: namespace,
						Name:      podName,
					}, pod); err != nil {
						return nil, fmt.Errorf("get warm-pool pod %s/%s for session binding: %w", namespace, podName, err)
					}
					before := pod.DeepCopy()
					if pod.Annotations == nil {
						pod.Annotations = make(map[string]string)
					}
					pod.Annotations[sessionIDAnnotationKey] = sessionID
					if err := c.client.Patch(waitCtx, pod, ctrlclient.MergeFrom(before)); err != nil {
						return nil, fmt.Errorf("bind warm-pool pod %s/%s to session: %w", namespace, podName, err)
					}
				}

				// Use ServiceFQDN when available — it's stable across Pod restarts.
				if createdSandbox.Status.Service != "" {
					fqdn := createdSandbox.Status.ServiceFQDN
					if fqdn == "" {
						fqdn = fmt.Sprintf("%s.%s.svc.cluster.local", createdSandbox.Status.Service, namespace)
					}
					// Quick fail check only — WarmPool Pods are already pre-warmed and verified:
					//   1. WarmPool controller creates and monitors pods
					//   2. isPodTerminallyFailed removes bad pods from pool
					//   3. tryAdoptPodFromPool skips failed pods during adoption
					// No need for waitForPodHealthy here (it can't find the Pod by label anyway —
					// adopted Pods use agents.x-k8s.io/sandbox label, not sandboxNameLabelKey).
					if failed, _ := c.isPodFailed(waitCtx, sandboxName, namespace); failed {
						return nil, c.timeoutErrorWithDiagnostics(sandboxName, namespace)
					}
					return &SandboxResult{SandboxName: sandboxName, Namespace: namespace, PodIP: fqdn, PodPort: 8080, Kind: "SandboxClaim"}, nil
				}
				// Fallback: get Pod IP via annotation → label → ownerRef lookup
				podName := sandboxName
				if annotated, ok := createdSandbox.Annotations["agents.x-k8s.io/pod-name"]; ok && annotated != "" {
					podName = annotated
				}
				podIP, err := c.GetSandboxPodIP(waitCtx, namespace, sandboxName, podName)
				if err != nil {
					return nil, fmt.Errorf("get pod IP for sandbox %s/%s: %w", namespace, sandboxName, err)
				}
				return &SandboxResult{SandboxName: sandboxName, Namespace: namespace, PodIP: podIP, PodPort: 8080, Kind: "SandboxClaim"}, nil
			case <-failCheckTicker.C:
				if failed, _ := c.isPodFailed(waitCtx, sandboxName, namespace); failed {
					return nil, c.timeoutErrorWithDiagnostics(sandboxName, namespace)
				}
			case <-waitCtx.Done():
				return nil, c.timeoutErrorWithDiagnostics(sandboxName, namespace)
			}
		}
	}

	// No reconciler — polling fallback
	podIP, err := c.waitForSandboxPodRunning(waitCtx, sandboxName, namespace)
	if err != nil {
		return nil, err
	}
	return &SandboxResult{SandboxName: sandboxName, Namespace: namespace, PodIP: podIP, PodPort: 8080, Kind: "SandboxClaim"}, nil
}

// waitForSandboxPodRunning waits for the Sandbox Pod to be Running and returns its IP.
// Uses GetSandboxPodIP with 3-layer lookup:
//  1. annotation → PodLister cache
//  2. label → PodLister cache
//  3. ownerRef filter
func (c *K8sSandboxCreator) waitForSandboxPodRunning(ctx context.Context, sandboxName, namespace string) (string, error) {
	return c.waitForPodRunning(ctx, sandboxName, namespace)
}

// waitForPodRunning waits until the Sandbox Pod is Running and returns its IP.
// If SandboxReconciler is attached, uses event-driven notification.
// Falls back to polling when reconciler is not available.
func (c *K8sSandboxCreator) waitForPodRunning(ctx context.Context, sandboxName, namespace string) (string, error) {
	timeout := 15 * time.Minute
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	// Event-driven path (preferred) — SandboxReconciler notifies us when sandbox is Ready.
	// While waiting, periodically check if the Pod has entered a terminal failure state
	// (e.g. CrashLoopBackOff, ErrImagePull, container exited with non-zero code).
	// This avoids waiting the full 2-minute timeout when a `run` step or image pull fails.
	if c.reconciler != nil {
		watchCh := c.reconciler.WatchSandboxOnce(ctx, namespace, sandboxName)
		defer c.reconciler.UnWatchSandbox(namespace, sandboxName)

		failCheckTicker := time.NewTicker(3 * time.Second)
		defer failCheckTicker.Stop()

		for {
			select {
			case update := <-watchCh:
				if update.Sandbox != nil && update.Sandbox.Status.Service != "" {
					fqdn := update.Sandbox.Status.ServiceFQDN
					if fqdn == "" {
						fqdn = fmt.Sprintf("%s.%s.svc.cluster.local", update.Sandbox.Status.Service, namespace)
					}
					// Quick fail check: if Pod already crashed, return error immediately.
					// Don't block here — normal pods may still be starting and that's fine.
					if failed, _ := c.isPodFailed(ctx, sandboxName, namespace); failed {
						return "", c.timeoutErrorWithDiagnostics(sandboxName, namespace)
					}
					return fqdn, nil
				}
				// Service not ready yet, fall through to polling
				failCheckTicker.Stop()
				goto polling
			case <-failCheckTicker.C:
				if failed, _ := c.isPodFailed(ctx, sandboxName, namespace); failed {
					return "", c.timeoutErrorWithDiagnostics(sandboxName, namespace)
				}
			case <-ctx.Done():
				return "", c.timeoutErrorWithDiagnostics(sandboxName, namespace)
			}
		}
	}
polling:

	// Polling fallback: poll until GetSandboxPodIP succeeds or Pod enters a terminal failure state.
	var podIP string
	err := wait.PollUntilContextTimeout(ctx, 2*time.Second, timeout, true, func(pCtx context.Context) (bool, error) {
		// First, read Sandbox to get pod-name annotation (WarmPool case)
		sb := &sandboxv1alpha1.Sandbox{}
		if err := c.client.Get(pCtx, types.NamespacedName{Name: sandboxName, Namespace: namespace}, sb); err != nil {
			if k8serrors.IsNotFound(err) {
				return false, nil
			}
			return false, err
		}
		podName := ""
		if annotated, ok := sb.Annotations["agents.x-k8s.io/pod-name"]; ok {
			podName = annotated
		}

		// Early failure detection: check if Pod entered a terminal error state.
		// This avoids waiting for the full 2-minute timeout when a `run` step fails.
		if failed, reason := c.isPodFailed(pCtx, sandboxName, namespace); failed {
			return false, fmt.Errorf("sandbox pod failed: %s", reason)
		}

		ip, err := c.GetSandboxPodIP(pCtx, namespace, sandboxName, podName)
		if err != nil {
			return false, nil // not ready yet
		}
		podIP = ip
		return true, nil
	})
	if err != nil {
		return "", c.timeoutErrorWithDiagnostics(sandboxName, namespace)
	}
	return podIP, nil
}

// waitForPodHealthy waits until the Pod is confirmed Running with all containers ready,
// or detects a terminal failure. This is needed because getSandboxPodPhase has a loose
// fallback (Replicas>0 && Service!="") that can fire before the Pod is truly healthy.
//
// Returns nil if the Pod is confirmed healthy, or an error with diagnostics if it fails.
func (c *K8sSandboxCreator) waitForPodHealthy(ctx context.Context, sandboxName, namespace string, maxWait time.Duration) error {
	checkCtx, cancel := context.WithTimeout(ctx, maxWait)
	defer cancel()

	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	// Track the last known failure reason. The Pod may be deleted between
	// failure detection and diagnostics collection, so we cache the reason.
	var lastFailReason string

	for {
		select {
		case <-ticker.C:
			// Check for terminal failure first — collect diagnostics IMMEDIATELY
			// because the Pod may be deleted shortly after entering Failed state.
			if failed, reason := c.isPodFailed(checkCtx, sandboxName, namespace); failed {
				lastFailReason = reason
				// Collect diagnostics right now while Pod still exists
				return c.timeoutErrorWithDiagnostics(sandboxName, namespace)
			}
			// Check if Pod disappeared (was deleted by controller)
			if lastFailReason == "" {
				podList := &corev1.PodList{}
				if err := c.client.List(checkCtx, podList,
					ctrlclient.InNamespace(namespace),
					ctrlclient.MatchingLabels{sandboxNameLabelKey: sandboxName},
				); err == nil && len(podList.Items) == 0 {
					// Pod was found before but now gone — it was likely deleted after failure
					return fmt.Errorf("sandbox %s/%s pod disappeared (likely crashed and was cleaned up)", namespace, sandboxName)
				}
			}
			// Check if Pod is truly Running with containers ready
			if c.isPodReady(checkCtx, sandboxName, namespace) {
				return nil
			}
		case <-checkCtx.Done():
			// maxWait exceeded — check one more time for failure
			if failed, reason := c.isPodFailed(context.Background(), sandboxName, namespace); failed {
				lastFailReason = reason
				return c.timeoutErrorWithDiagnostics(sandboxName, namespace)
			}
			// If Pod is Ready at timeout, it's healthy — let it proceed.
			if c.isPodReady(context.Background(), sandboxName, namespace) {
				return nil
			}
			// Pod is neither Failed nor Ready after maxWait.
			// Use cached failure reason if available.
			if lastFailReason != "" {
				return fmt.Errorf("sandbox %s/%s failed: %s", namespace, sandboxName, lastFailReason)
			}
			// No cached reason — collect whatever diagnostics we can
			return c.timeoutErrorWithDiagnostics(sandboxName, namespace)
		}
	}
}

// isPodReady checks if the sandbox Pod is Running with all containers in Ready state.
// With the readiness probe on the main container (HTTP GET /health on port 8080),
// Ready=true means EnvD is actually serving — all run steps have completed successfully.
func (c *K8sSandboxCreator) isPodReady(ctx context.Context, sandboxName, namespace string) bool {
	podList := &corev1.PodList{}
	if err := c.client.List(ctx, podList,
		ctrlclient.InNamespace(namespace),
		ctrlclient.MatchingLabels{sandboxNameLabelKey: sandboxName},
	); err != nil || len(podList.Items) == 0 {
		return false
	}
	pod := &podList.Items[0]

	if pod.Status.Phase != corev1.PodRunning {
		return false
	}
	if len(pod.Status.ContainerStatuses) == 0 {
		return false
	}
	// All containers must be Ready.
	// The readiness probe ensures Ready=true only after EnvD is responding on /health.
	for _, cs := range pod.Status.ContainerStatuses {
		if !cs.Ready {
			return false
		}
	}
	return true
}

// isPodFailed checks if the sandbox Pod has entered a terminal failure state.
// Returns (true, reason) if the Pod is in Failed phase, has a terminated container
// with non-zero exit code, or is stuck in CrashLoopBackOff / ErrImagePull.
// This enables early exit from the polling loop instead of waiting for the full timeout.
func (c *K8sSandboxCreator) isPodFailed(ctx context.Context, sandboxName, namespace string) (bool, string) {
	podList := &corev1.PodList{}
	if err := c.client.List(ctx, podList,
		ctrlclient.InNamespace(namespace),
		ctrlclient.MatchingLabels{sandboxNameLabelKey: sandboxName},
	); err != nil || len(podList.Items) == 0 {
		return false, ""
	}
	pod := &podList.Items[0]

	// Pod-level failure
	if pod.Status.Phase == corev1.PodFailed {
		return true, fmt.Sprintf("pod phase: Failed (reason: %s)", pod.Status.Reason)
	}

	// Check init containers first — they run before main containers
	for _, cs := range pod.Status.InitContainerStatuses {
		if cs.State.Terminated != nil && cs.State.Terminated.ExitCode != 0 {
			return true, fmt.Sprintf("init-container %q exited with code %d", cs.Name, cs.State.Terminated.ExitCode)
		}
		if cs.State.Waiting != nil {
			switch cs.State.Waiting.Reason {
			case "ErrImagePull", "ImagePullBackOff", "InvalidImageName":
				return true, fmt.Sprintf("init-container %q: %s", cs.Name, cs.State.Waiting.Reason)
			}
		}
	}

	// Check main containers
	for _, cs := range pod.Status.ContainerStatuses {
		if cs.State.Terminated != nil && cs.State.Terminated.ExitCode != 0 {
			return true, fmt.Sprintf("container %q exited with code %d", cs.Name, cs.State.Terminated.ExitCode)
		}
		if cs.State.Waiting != nil {
			switch cs.State.Waiting.Reason {
			case "CrashLoopBackOff", "ErrImagePull", "ImagePullBackOff", "InvalidImageName", "CreateContainerConfigError":
				return true, fmt.Sprintf("container %q: %s", cs.Name, cs.State.Waiting.Reason)
			}
		}
	}

	return false, ""
}

// timeoutErrorWithDiagnostics builds a timeout error message enriched with Pod failure details.
// Uses a fresh context (5s deadline) since the original context has already expired.
func (c *K8sSandboxCreator) timeoutErrorWithDiagnostics(sandboxName, namespace string) error {
	diagCtx, diagCancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer diagCancel()
	details := c.getPodFailureDetails(diagCtx, sandboxName, namespace)
	if details != "" {
		return fmt.Errorf("timeout waiting for sandbox %s/%s to be Running.\n\nPod diagnostics:\n%s",
			namespace, sandboxName, details)
	}
	return fmt.Errorf("timeout waiting for sandbox %s/%s to be Running", namespace, sandboxName)
}

// getPodFailureDetails fetches container status and logs from the sandbox Pod
// when it fails to start (e.g. due to a failing `run` step in the template).
// Returns a human-readable diagnostic string, or empty if details are unavailable.
func (c *K8sSandboxCreator) getPodFailureDetails(ctx context.Context, sandboxName, namespace string) string {
	// Find the Pod by sandbox-name label
	podList := &corev1.PodList{}
	if err := c.client.List(ctx, podList,
		ctrlclient.InNamespace(namespace),
		ctrlclient.MatchingLabels{sandboxNameLabelKey: sandboxName},
	); err != nil || len(podList.Items) == 0 {
		return ""
	}
	pod := &podList.Items[0]

	var details []string

	// Collect container status info (waiting / terminated reasons)
	for _, cs := range pod.Status.ContainerStatuses {
		if cs.State.Waiting != nil && cs.State.Waiting.Reason != "" {
			details = append(details, fmt.Sprintf("container %q: %s — %s",
				cs.Name, cs.State.Waiting.Reason, cs.State.Waiting.Message))
		}
		if cs.State.Terminated != nil && cs.State.Terminated.ExitCode != 0 {
			details = append(details, fmt.Sprintf("container %q exited with code %d — %s",
				cs.Name, cs.State.Terminated.ExitCode, cs.State.Terminated.Message))
		}
	}
	// Also check init container statuses
	for _, cs := range pod.Status.InitContainerStatuses {
		if cs.State.Waiting != nil && cs.State.Waiting.Reason != "" {
			details = append(details, fmt.Sprintf("init-container %q: %s — %s",
				cs.Name, cs.State.Waiting.Reason, cs.State.Waiting.Message))
		}
		if cs.State.Terminated != nil && cs.State.Terminated.ExitCode != 0 {
			details = append(details, fmt.Sprintf("init-container %q exited with code %d — %s",
				cs.Name, cs.State.Terminated.ExitCode, cs.State.Terminated.Message))
		}
	}

	// Fetch container logs (last 50 lines) for the main container.
	// Use a generous timeout since the original context may have expired.
	if c.kubeClient != nil {
		logCtx, logCancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer logCancel()
		tailLines := int64(50)
		logReq := c.kubeClient.CoreV1().Pods(namespace).GetLogs(pod.Name, &corev1.PodLogOptions{
			Container: "codeinterpreter",
			TailLines: &tailLines,
		})
		logStream, err := logReq.Stream(logCtx)
		if err != nil {
			// Log fetch failed — include the error in diagnostics so the user knows why
			details = append(details, fmt.Sprintf("(container logs unavailable: %v)", err))
		} else {
			defer logStream.Close()
			logBytes, _ := io.ReadAll(logStream)
			logStr := strings.TrimSpace(string(logBytes))
			if logStr != "" {
				details = append(details, "--- container logs (last 50 lines) ---")
				details = append(details, logStr)
			}
		}
	} else {
		details = append(details, "(container logs unavailable: kubeClient not initialized)")
	}

	return strings.Join(details, "\n")
}

// randString generates an n-char random lowercase alphanumeric string (K8s RFC 1123 compliant).
func randString(n int) string {
	const letters = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, n)
	for i := range b {
		b[i] = letters[rand.Intn(len(letters))] //nolint:gosec // naming only
	}
	return string(b)
}

// DeleteSandbox deletes the Sandbox object (Pod is cascade-deleted by controller).
// DeleteSandbox deletes a Sandbox object (Pod is cascade-deleted by controller).
func (c *K8sSandboxCreator) DeleteSandbox(ctx context.Context, info *store.SandboxInfo) error {
	sandbox := &sandboxv1alpha1.Sandbox{}
	if err := c.client.Get(ctx, types.NamespacedName{Name: info.SandboxName, Namespace: info.Namespace}, sandbox); err != nil {
		if k8serrors.IsNotFound(err) {
			return nil
		}
		return err
	}
	return ctrlclient.IgnoreNotFound(c.client.Delete(ctx, sandbox))
}

// DeleteSandboxClaim deletes a WarmPool-based sandbox session.
//
// When a Pod is adopted from the WarmPool, the SandboxClaim controller:
//  1. Removes the Pod's OwnerReferences (orphaning it from SandboxWarmPool)
//  2. Removes pool labels (making it invisible to WarmPool controller)
//  3. Sets agents.x-k8s.io/pod-name annotation on the Sandbox
//
// Because the Pod has no OwnerReference, K8s GC will NOT cascade-delete it
// when the Sandbox or SandboxClaim is deleted. We must explicitly delete
// the Pod, the Sandbox, and the SandboxClaim in order.
//
// Without this, adopted Pods become permanent zombies — consuming resources,
// blocking WarmPool replenishment, and (with authMode=none) remaining
// accessible without authentication.
func (c *K8sSandboxCreator) DeleteSandboxClaim(ctx context.Context, info *store.SandboxInfo) error {
	key := types.NamespacedName{Name: info.SandboxName, Namespace: info.Namespace}

	// Step 1: Find the Sandbox to get the adopted Pod's real name.
	// The Sandbox name equals the SandboxClaim name (set by the claim controller).
	// Held rather than deleted here: the Claim has to go first (Step 3).
	var sandboxToDelete *sandboxv1alpha1.Sandbox
	sandbox := &sandboxv1alpha1.Sandbox{}
	if err := c.client.Get(ctx, key, sandbox); err == nil {
		// Step 2: Delete the adopted Pod directly.
		// The Pod name may differ from the Sandbox name (WarmPool pod naming).
		podName := sandbox.Name
		if annotated, ok := sandbox.Annotations["agents.x-k8s.io/pod-name"]; ok && annotated != "" {
			podName = annotated
		}
		pod := &corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{
				Name:      podName,
				Namespace: info.Namespace,
			},
		}
		// The Pod's error is kept, and it also gates what happens next.
		// Dropping it was the zombie this function's own comment describes: the
		// Pod has no OwnerReference, so nothing cascades to it, and deleting the
		// Claim below removes the annotation above that names it -- leaving a
		// Pod that nothing in this teardown path will come back for.
		//
		// A nil error is enough to go on. It does not mean the Pod is gone, only
		// that the API server accepted the deletion and set deletionTimestamp,
		// and finishing is then the kubelet's. An error is the case worth
		// stopping for: the deletion may never have been accepted at all, so the
		// Pod may have no deletionTimestamp and no reason to ever go away.
		podErr := ctrlclient.IgnoreNotFound(c.client.Delete(ctx, pod))
		if podErr != nil {
			// The Claim carries no Pod reference, and this annotation is the
			// only thing that names the Pod *directly*. Deleting the Sandbox now
			// would take that name with it, for a Pod that may not be going
			// anywhere. It would still be reachable the long way round -- the
			// claim controller labels an adopted Pod with sandbox-name-hash,
			// which is fnv-1a of this same name and so recomputable without any
			// of these objects -- but a teardown should not have to be recovered
			// from by search. So it stops here, with both objects intact.
			return fmt.Errorf("delete warm-pool pod %s/%s (sandbox %s retained so its %s annotation still names it): %w",
				info.Namespace, podName, info.SandboxName, "agents.x-k8s.io/pod-name", podErr)
		}

		sandboxToDelete = sandbox
	} else if !k8serrors.IsNotFound(err) {
		return fmt.Errorf("get sandbox %s/%s: %w", info.Namespace, info.SandboxName, err)
	}

	// Step 3: Delete the SandboxClaim -- before the Sandbox, not after.
	//
	// The Claim is what the claim controller reconciles, and a live Claim whose
	// Sandbox has gone missing is precisely its cue to build another one: it
	// watches Sandboxes it owns, so the deletion below wakes it, and it returns
	// early only for a Claim that is absent or already terminating. Deleting the
	// Sandbox first opens a window where neither is true, and what it does in
	// that window is adopt a second Pod out of the warm pool and strip its
	// OwnerReferences -- which this teardown then walks away from, having
	// already accounted for the first one. A second orphan, made by the
	// rollback, of exactly the kind the Pod handling above exists to prevent.
	//
	// Ordering closes it rather than racing it. Once the Claim is gone or
	// carries a deletionTimestamp there is no reconcile that recreates
	// anything, so the Sandbox delete that follows cannot be undone.
	//
	// It stays after the Pod for the reason it always did: a Pod that would not
	// delete keeps both records, because the Claim is what a retry finds this
	// through and the Sandbox is the only thing that still names the Pod. That
	// gate is above and unchanged -- this step is only reached once the Pod is
	// gone or was already absent.
	claim := &extensionsv1alpha1.SandboxClaim{}
	if err := c.client.Get(ctx, key, claim); err == nil {
		if err := ctrlclient.IgnoreNotFound(c.client.Delete(ctx, claim)); err != nil {
			// The Sandbox is deliberately left behind: it is still the only
			// thing naming the adopted Pod, and the Claim that survived is what
			// a retry comes back through.
			return fmt.Errorf("delete warm-pool claim %s/%s: %w",
				info.Namespace, info.SandboxName, err)
		}
	} else if !k8serrors.IsNotFound(err) {
		return err
	}

	// Step 4: Delete the Sandbox (triggers Service cleanup by the sandbox
	// controller). Only reached once the Pod is gone or was already absent, so
	// the pod-name annotation is being discarded with nothing left to find
	// through it -- and once the Claim can no longer recreate it.
	//
	// The Claim controls the Sandbox, so its deletion may well have taken this
	// one with it already; IgnoreNotFound is what makes that the same outcome
	// rather than a failure.
	if sandboxToDelete == nil {
		return nil
	}
	if err := ctrlclient.IgnoreNotFound(c.client.Delete(ctx, sandboxToDelete)); err != nil {
		return fmt.Errorf("delete warm-pool sandbox %s/%s: %w",
			info.Namespace, info.SandboxName, err)
	}
	return nil
}

// ── Overrides ────────────────────────────────────────────────────────────────

const systemAnnotationPrefix = "runtime.agent-sandbox.io/"

// Default sandbox lifetime applied when neither template nor override specifies one.
// Users and templates can freely configure a longer (or shorter) MaxSessionDuration;
// it is no longer capped.
const (
	// DefaultMaxSessionDuration is the fallback sandbox lifetime (24h) used when
	// the CodeInterpreter spec and user overrides both leave maxSessionDuration unset.
	DefaultMaxSessionDuration = 24 * time.Hour
)

// shutdownTimeFromDuration returns ShutdownTime = now + d.
// Returns zero metav1.Time when d <= 0 (caller should treat as "no shutdown time").
func shutdownTimeFromDuration(d time.Duration) metav1.Time {
	if d <= 0 {
		return metav1.Time{}
	}
	return metav1.NewTime(time.Now().Add(d))
}

// applyOverrides merges safe user overrides into the Pod template, labels, annotations, and shutdown time.
func applyOverrides(
	overrides *SandboxOverrides,
	ci *runtimev1alpha1.CodeInterpreter,
	podTemplate *sandboxv1alpha1.PodTemplate,
	sandboxLabels map[string]string,
	annotations map[string]string,
	shutdownTime **metav1.Time,
) {
	if overrides == nil {
		return
	}

	// 1. Environment variables: merge into the first container
	if len(overrides.Environment) > 0 && len(podTemplate.Spec.Containers) > 0 {
		container := &podTemplate.Spec.Containers[0]
		for k, v := range overrides.Environment {
			found := false
			for i, env := range container.Env {
				if env.Name == k {
					container.Env[i].Value = v
					found = true
					break
				}
			}
			if !found {
				container.Env = append(container.Env, corev1.EnvVar{Name: k, Value: v})
			}
		}
	}

	// 2. SessionTimeout: user can freely override (no hard cap).
	// maxSessionDuration (24h) is the final backstop for sandbox lifetime.
	if overrides.SessionTimeout != "" {
		if userDur, err := time.ParseDuration(overrides.SessionTimeout); err == nil && userDur > 0 {
			annotations[idleTimeoutAnnotationKey] = userDur.String()
		}
	}

	// 3. MaxSessionDuration: user can freely override, no hard cap.
	if overrides.MaxSessionDuration != "" {
		if userDur, err := time.ParseDuration(overrides.MaxSessionDuration); err == nil && userDur > 0 {
			st := shutdownTimeFromDuration(userDur)
			*shutdownTime = &st
		}
	}

	// 4. RuntimeClassName: override Pod runtime class (only effective for non-WarmPool sandboxes,
	// since WarmPool pods are pre-created and their PodSpec is immutable).
	if overrides.RuntimeClassName != nil {
		rc := *overrides.RuntimeClassName
		if rc == "" {
			podTemplate.Spec.RuntimeClassName = nil
		} else {
			podTemplate.Spec.RuntimeClassName = &rc
		}
	}

	// 5. Labels: merge (reject system prefix)
	for k, v := range overrides.Labels {
		if !strings.HasPrefix(k, systemAnnotationPrefix) {
			sandboxLabels[k] = v
		}
	}

	// 6. Annotations: merge (reject system prefix)
	for k, v := range overrides.Annotations {
		if !strings.HasPrefix(k, systemAnnotationPrefix) {
			annotations[k] = v
		}
	}
}

// RecoverSessionFromK8s rebuilds a SandboxInfo by searching K8s for a Sandbox
// with a matching session-id annotation. This is the fallback path when Redis
// data is lost (e.g. Redis restart without persistence).
//
// Returns the recovered SandboxInfo or an error if not found.
func (c *K8sSandboxCreator) RecoverSessionFromK8s(ctx context.Context, sessionID string) (*store.SandboxInfo, error) {
	sb, err := c.findSandboxBySessionID(ctx, sessionID)
	if err != nil {
		return nil, err
	}

	sandboxName := sb.Name
	namespace := sb.Namespace

	// Prefer ServiceFQDN (stable across Pod restarts).
	var podIP string
	if sb.Status.ServiceFQDN != "" {
		podIP = sb.Status.ServiceFQDN
	} else if sb.Status.Service != "" {
		podIP = fmt.Sprintf("%s.%s.svc.cluster.local", sb.Status.Service, namespace)
	} else {
		// Fallback: get Pod IP from the pod.
		podName := sandboxName
		if annotated, ok := sb.Annotations["agents.x-k8s.io/pod-name"]; ok && annotated != "" {
			podName = annotated
		}
		ip, err := c.GetSandboxPodIP(ctx, namespace, sandboxName, podName)
		if err != nil {
			return nil, fmt.Errorf("sandbox %s/%s found but pod IP unavailable: %w", namespace, sandboxName, err)
		}
		podIP = ip
	}

	// Determine Kind from ownerReferences (SandboxClaim → "SandboxClaim", else → "Sandbox")
	kind := store.SandboxKind
	for _, ref := range sb.OwnerReferences {
		if ref.Kind == "SandboxClaim" {
			kind = store.SandboxClaimKind
			break
		}
	}

	// Reconstruct SandboxInfo.
	info := &store.SandboxInfo{
		Kind:         kind,
		SessionID:    sessionID,
		SandboxName:  sandboxName,
		Namespace:    namespace,
		PodIP:        podIP,
		PodPort:      8080,
		EntryPoints:  map[string]string{"/": fmt.Sprintf("%s:%d", podIP, 8080)},
		CreatedAt:    sb.CreationTimestamp.Time,
		LastActivity: time.Now(),
		ExpiresAt:    time.Now().Add(DefaultMaxSessionDuration), // default; Lifecycle overrides below
		Status:       "running",
	}

	// Recover user identity from annotations/labels.
	if uid, ok := sb.Labels[userIDLabelKey]; ok {
		info.UserID = uid
	}
	if uname, ok := sb.Annotations[userNameAnnotationKey]; ok {
		info.UserName = uname
	}

	// Use Lifecycle.ShutdownTime for accurate ExpiresAt.
	if !sb.Spec.Lifecycle.ShutdownTime.IsZero() {
		info.ExpiresAt = sb.Spec.Lifecycle.ShutdownTime.Time
	}

	return info, nil
}

// findSandboxBySessionID resolves a session id to its Sandbox.
//
// Prefers the indexed cache: this runs once per keepalive poll per session while
// the store cannot answer, and a List of every Sandbox at that rate turns a store
// outage into API server load. Falls back to that List when the cache cannot
// serve the query -- before it has synced, or in a deployment wired without a
// reader or without the index -- so the worst case is what this path did before.
//
// A cache read can lag a creation by the length of a watch delivery. Recovery
// only ever asks about sandboxes that already outlived their stored record, so
// the miss is not reachable in practice, and the next poll would catch it.
func (c *K8sSandboxCreator) findSandboxBySessionID(
	ctx context.Context, sessionID string,
) (*sandboxv1alpha1.Sandbox, error) {
	if c.cachedReader != nil {
		indexed := &sandboxv1alpha1.SandboxList{}
		err := c.cachedReader.List(ctx, indexed, ctrlclient.MatchingFields{SessionIDIndexField: sessionID})
		switch {
		case err != nil:
			slog.Warn("indexed sandbox lookup unavailable, falling back to a full list",
				"sessionId", sessionID, "error", err)
		case len(indexed.Items) > 0:
			return c.confirmSandbox(ctx, sessionID, &indexed.Items[0])
		default:
			// The index answered, so this is absence rather than an unanswered
			// question. Listing would only repeat it at a much higher price.
			return nil, fmt.Errorf("no sandbox found with session-id %q", sessionID)
		}
	}

	// Annotations cannot be selected on server-side, so this filters in Go.
	sandboxList := &sandboxv1alpha1.SandboxList{}
	if err := c.client.List(ctx, sandboxList); err != nil {
		return nil, fmt.Errorf("list sandboxes: %w", err)
	}
	for i := range sandboxList.Items {
		if sandboxList.Items[i].Annotations[sessionIDAnnotationKey] != sessionID {
			continue
		}
		if err := rejectIfTerminating(sessionID, &sandboxList.Items[i]); err != nil {
			return nil, err
		}
		return &sandboxList.Items[i], nil
	}
	return nil, fmt.Errorf("no sandbox found with session-id %q", sessionID)
}

// confirmSandbox re-reads a cache hit from the API server before it is used to
// rebuild a session record.
//
// The cache lags deletion by the length of a watch delivery, and idle-gc deletes a
// Sandbox and drops its session mapping in the same breath. Recovering from a copy
// that only the cache still holds would put that mapping straight back, pointing at
// a Pod that is gone, for as long as its TTL -- which tracks the sandbox's 24h
// expiry, not the idle timeout. That is the outcome the deregistration exists to
// prevent, so the cache is trusted to find the candidate and not to vouch for it.
//
// One Get, against the same client the fallback would have listed with.
func (c *K8sSandboxCreator) confirmSandbox(
	ctx context.Context, sessionID string, cached *sandboxv1alpha1.Sandbox,
) (*sandboxv1alpha1.Sandbox, error) {
	confirmed := &sandboxv1alpha1.Sandbox{}
	if err := c.client.Get(ctx, ctrlclient.ObjectKeyFromObject(cached), confirmed); err != nil {
		return nil, fmt.Errorf("confirm sandbox %s/%s for session %q: %w",
			cached.Namespace, cached.Name, sessionID, err)
	}
	if err := rejectIfTerminating(sessionID, confirmed); err != nil {
		return nil, err
	}
	return confirmed, nil
}

// rejectIfTerminating refuses a Sandbox on its way out. Rebuilding a session record
// for one would answer the caller with an address about to stop serving, and leave
// the mapping behind after it does.
func rejectIfTerminating(sessionID string, sb *sandboxv1alpha1.Sandbox) error {
	if !sb.DeletionTimestamp.IsZero() {
		return fmt.Errorf("sandbox %s/%s for session %q is being deleted",
			sb.Namespace, sb.Name, sessionID)
	}
	return nil
}
