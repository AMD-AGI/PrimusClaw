// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package controllers

import (
	"context"
	"reflect"
	"testing"
	"time"

	"github.com/go-logr/logr"
	"github.com/stretchr/testify/require"
	corev1 "k8s.io/api/core/v1"
	policyv1 "k8s.io/api/policy/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/intstr"
	toolscache "k8s.io/client-go/tools/cache"
	"k8s.io/utils/ptr"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/config"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllertest"
	"sigs.k8s.io/controller-runtime/pkg/manager"

	sandboxv1alpha1 "sigs.k8s.io/agent-sandbox/api/v1alpha1"
	asmetrics "sigs.k8s.io/agent-sandbox/internal/metrics"
)

// captureInformer hands the test the event handler SetupWithManager installs.
type captureInformer struct {
	*controllertest.FakeInformer
	handler chan toolscache.ResourceEventHandler
}

func (i *captureInformer) AddEventHandlerWithOptions(h toolscache.ResourceEventHandler,
	opts toolscache.HandlerOptions) (toolscache.ResourceEventHandlerRegistration, error) {
	reg, err := i.FakeInformer.AddEventHandlerWithOptions(h, opts)
	i.handler <- h
	return reg, err
}

type watchCache struct {
	cache.Cache
	informers map[reflect.Type]*captureInformer
}

func (c *watchCache) GetInformer(_ context.Context, obj client.Object, _ ...cache.InformerGetOption) (cache.Informer, error) {
	return c.informers[reflect.TypeOf(obj)], nil
}

func (c *watchCache) WaitForCacheSync(context.Context) bool { return true }

// watchManager is just enough of a manager for SetupWithManager to build the
// real controller, its watches and its predicates, with no API server.
type watchManager struct {
	manager.Manager
	cache    *watchCache
	mapper   meta.RESTMapper
	runnable manager.Runnable
}

func (m *watchManager) GetScheme() *runtime.Scheme     { return Scheme }
func (m *watchManager) GetCache() cache.Cache          { return m.cache }
func (m *watchManager) GetRESTMapper() meta.RESTMapper { return m.mapper }
func (m *watchManager) GetLogger() logr.Logger         { return logr.Discard() }
func (m *watchManager) Add(r manager.Runnable) error   { m.runnable = r; return nil }
func (m *watchManager) GetControllerOptions() config.Controller {
	return config.Controller{SkipNameValidation: ptr.To(true), CacheSyncTimeout: time.Second}
}

// startWatches runs the controller SetupWithManager builds and returns the
// event handler it installed for budgets.
func startWatches(t *testing.T, r *SandboxReconciler) toolscache.ResourceEventHandler {
	t.Helper()
	c := &watchCache{informers: map[reflect.Type]*captureInformer{}}
	for _, obj := range []client.Object{&sandboxv1alpha1.Sandbox{}, &corev1.Pod{}, &corev1.Service{},
		&policyv1.PodDisruptionBudget{}} {
		c.informers[reflect.TypeOf(obj)] = &captureInformer{
			FakeInformer: controllertest.NewFakeInformer(controllertest.Synced),
			handler:      make(chan toolscache.ResourceEventHandler, 1),
		}
	}
	mapper := meta.NewDefaultRESTMapper(nil)
	mapper.Add(sandboxv1alpha1.GroupVersion.WithKind("Sandbox"), meta.RESTScopeNamespace)
	m := &watchManager{cache: c, mapper: mapper}
	require.NoError(t, r.SetupWithManager(m))
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan error, 1)
	go func() { done <- m.runnable.Start(ctx) }()
	t.Cleanup(func() {
		cancel()
		select {
		case err := <-done:
			require.NoError(t, err)
		case <-time.After(3 * time.Second):
			t.Error("the controller did not stop")
		}
	})
	select {
	case h := <-c.informers[reflect.TypeOf(&policyv1.PodDisruptionBudget{})].handler:
		return h
	case <-time.After(3 * time.Second):
		t.Fatal("no budget event handler was installed")
		return nil
	}
}

// A spec edit of a budget reaches its Sandbox through the watch the controller
// registers, and is restored, also when the edit removes the budget's label:
// a watch that asked for the label would hide that drift for good.
func TestABudgetSpecEditReachesItsSandboxThroughTheWatch(t *testing.T) {
	sb, pod := readySandbox()
	r := &SandboxReconciler{Client: newFakeClient(sb, pod), Scheme: Scheme, Tracer: asmetrics.NewNoOp()}
	require.NoError(t, reconcileSandbox(t, r, sb))
	handler := startWatches(t, r)
	key := client.ObjectKeyFromObject(sb)
	restored := func() bool {
		live := &policyv1.PodDisruptionBudget{}
		return r.Get(t.Context(), key, live) == nil && live.Spec.MinAvailable != nil && live.Spec.MinAvailable.IntVal == 1
	}
	for _, dropLabels := range []bool{false, true} {
		live := &policyv1.PodDisruptionBudget{}
		require.NoError(t, r.Get(t.Context(), key, live))
		edited := live.DeepCopy()
		edited.Generation++
		edited.Spec.MinAvailable = ptr.To(intstr.FromInt32(0))
		if dropLabels {
			edited.Labels = nil
		}
		require.NoError(t, r.Update(t.Context(), edited))
		handler.OnUpdate(live, edited)
		require.Eventually(t, restored, 2*time.Second, 10*time.Millisecond,
			"the drift was not restored (labels removed: %v)", dropLabels)
	}
}
