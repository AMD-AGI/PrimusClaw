// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	"sigs.k8s.io/controller-runtime/pkg/client/interceptor"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
)

const (
	storeNS   = "agent-sandbox-system"
	storeName = "owner-policy"
	storeSpec = `{"fromImage":"harbor.example/runner@sha256:0123456789abcdef"}`
)

// storePolicy keeps a default quota with one field so a rewrite that drops
// absent fields would show up as a changed document.
const storePolicy = `{"templates":[{"name":"runner","perGpuCount":[1],"spec":` + storeSpec + `}],"default":{"maxSandboxes":2}}`

type storeRig struct {
	store  *OwnerPolicyStore
	svc    *Service
	cl     ctrlclient.Client
	leader *atomic.Bool
}

// newStoreRig builds a store over a fake cluster. updateCM, when set, answers
// every ConfigMap update instead of the fake client.
func newStoreRig(t *testing.T, policy string, updateCM func(cl ctrlclient.WithWatch, obj ctrlclient.Object) error) *storeRig {
	t.Helper()
	scheme := runtime.NewScheme()
	if err := runtimev1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	if err := corev1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	cm := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: storeName, Namespace: storeNS},
		Data:       map[string]string{OwnerPolicyKey: policy},
	}
	builder := fake.NewClientBuilder().WithScheme(scheme).WithObjects(cm).
		WithStatusSubresource(&runtimev1alpha1.SandboxGrant{})
	if updateCM != nil {
		builder = builder.WithInterceptorFuncs(interceptor.Funcs{
			Update: func(ctx context.Context, cl ctrlclient.WithWatch, obj ctrlclient.Object, opts ...ctrlclient.UpdateOption) error {
				if _, ok := obj.(*corev1.ConfigMap); ok {
					return updateCM(cl, obj)
				}
				return cl.Update(ctx, obj, opts...)
			},
		})
	}
	cl := builder.Build()
	svc := New(Options{Client: cl, Namespace: storeNS})
	leader := &atomic.Bool{}
	leader.Store(true)
	store := NewOwnerPolicyStore(cl, cl, storeNS, storeName, svc, leader.Load)
	return &storeRig{store: store, svc: svc, cl: cl, leader: leader}
}

func (r *storeRig) stored(t *testing.T) string {
	t.Helper()
	cm := &corev1.ConfigMap{}
	if err := r.cl.Get(context.Background(), types.NamespacedName{Namespace: storeNS, Name: storeName}, cm); err != nil {
		t.Fatal(err)
	}
	return cm.Data[OwnerPolicyKey]
}

func (r *storeRig) setStored(t *testing.T, raw string) {
	t.Helper()
	cm := &corev1.ConfigMap{}
	if err := r.cl.Get(context.Background(), types.NamespacedName{Namespace: storeNS, Name: storeName}, cm); err != nil {
		t.Fatal(err)
	}
	cm.Data[OwnerPolicyKey] = raw
	if err := r.cl.Update(context.Background(), cm); err != nil {
		t.Fatal(err)
	}
}

func (r *storeRig) ciExists(t *testing.T, name string) bool {
	t.Helper()
	err := r.cl.Get(context.Background(), types.NamespacedName{Namespace: storeNS, Name: name}, &runtimev1alpha1.CodeInterpreter{})
	return err == nil
}

func (r *storeRig) appliedTemplates() string {
	cfg := r.svc.owner.Load()
	if cfg == nil {
		return ""
	}
	return strings.Join(cfg.roleSpec, ",")
}

func opStatus(err error) int {
	var op *OpError
	if errors.As(err, &op) {
		return op.Status
	}
	return 0
}

func TestOwnerPolicyStorePutAndDelete(t *testing.T) {
	ctx := context.Background()
	r := newStoreRig(t, storePolicy, nil)
	if err := r.store.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if !r.ciExists(t, "e2b-runner-g1") {
		t.Fatal("sync did not register the policy template")
	}

	if err := r.store.PutTemplate(ctx, TemplateRequest{Name: "extra", PerGPUCount: []int32{1}, Spec: json.RawMessage(storeSpec)}); err != nil {
		t.Fatal(err)
	}
	if !r.ciExists(t, "e2b-extra-g1") || !strings.Contains(r.appliedTemplates(), "e2b-extra-g1") {
		t.Fatalf("put did not apply the new template: %s", r.appliedTemplates())
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal([]byte(r.stored(t)), &doc); err != nil {
		t.Fatal(err)
	}
	var quota bytes.Buffer
	if err := json.Compact(&quota, doc["default"]); err != nil || quota.String() != `{"maxSandboxes":2}` {
		t.Fatalf("default quota rewritten: %s", doc["default"])
	}
	out, err := r.store.Templates(ctx)
	if err != nil || len(out.Templates) != 2 || out.Templates[1].Name != "extra" || !out.InSync {
		t.Fatalf("templates=%+v err=%v", out, err)
	}

	if err := r.store.DeleteTemplate(ctx, "extra"); err != nil {
		t.Fatal(err)
	}
	if r.ciExists(t, "e2b-extra-g1") {
		t.Fatal("delete kept the dropped template")
	}
	if err := r.store.DeleteTemplate(ctx, "extra"); opStatus(err) != http.StatusNotFound {
		t.Fatalf("delete missing: %v", err)
	}
	if err := r.store.DeleteTemplate(ctx, "runner"); opStatus(err) != http.StatusBadRequest {
		t.Fatalf("delete last: %v", err)
	}
}

func TestOwnerPolicyStoreReplacesTemplate(t *testing.T) {
	ctx := context.Background()
	r := newStoreRig(t, storePolicy, nil)
	if err := r.store.PutTemplate(ctx, TemplateRequest{Name: "runner", PerGPUCount: []int32{1, 8}, Spec: json.RawMessage(storeSpec)}); err != nil {
		t.Fatal(err)
	}
	out, err := r.store.Templates(ctx)
	if err != nil || len(out.Templates) != 1 || len(out.Templates[0].PerGPUCount) != 2 {
		t.Fatalf("templates=%+v err=%v", out, err)
	}
	if !r.ciExists(t, "e2b-runner-g8") {
		t.Fatal("replaced template did not register the new size")
	}
}

func TestOwnerPolicyStoreRejectsWithoutWriting(t *testing.T) {
	ctx := context.Background()
	r := newStoreRig(t, storePolicy, nil)
	before := r.stored(t)
	for _, tpl := range []TemplateRequest{
		{Name: "", Spec: json.RawMessage(storeSpec)},
		{Name: "nospec"},
		{Name: "bad", Spec: json.RawMessage(`{"fromImage":`)},
	} {
		if err := r.store.PutTemplate(ctx, tpl); err == nil {
			t.Fatalf("put %q accepted", tpl.Name)
		}
	}
	if r.stored(t) != before {
		t.Fatalf("rejected put changed the ConfigMap: %s", r.stored(t))
	}
}

// A failed save must leave the shared templates and the applied policy as they were.
func TestOwnerPolicyStoreFailedSaveChangesNothing(t *testing.T) {
	ctx := context.Background()
	forbidden := apierrors.NewForbidden(schema.GroupResource{Resource: "configmaps"}, storeName, errors.New("rbac"))
	r := newStoreRig(t, `{"templates":[{"name":"runner","perGpuCount":[1],"spec":`+storeSpec+`},{"name":"extra","perGpuCount":[1],"spec":`+storeSpec+`}]}`,
		func(ctrlclient.WithWatch, ctrlclient.Object) error { return forbidden })
	if err := r.store.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	before := r.appliedTemplates()
	if err := r.store.DeleteTemplate(ctx, "extra"); err == nil {
		t.Fatal("delete succeeded without saving")
	}
	if !r.ciExists(t, "e2b-extra-g1") || r.appliedTemplates() != before {
		t.Fatalf("failed save changed the cluster: applied=%s", r.appliedTemplates())
	}
}

// A conflicting save is retried from the new content, and nothing is applied before it.
func TestOwnerPolicyStoreConflictHasNoSideEffects(t *testing.T) {
	ctx := context.Background()
	var r *storeRig
	conflicts := 0
	r = newStoreRig(t, storePolicy, func(cl ctrlclient.WithWatch, obj ctrlclient.Object) error {
		if conflicts == 0 {
			conflicts++
			if r.ciExists(t, "e2b-extra-g1") {
				t.Error("template registered before the save")
			}
			return apierrors.NewConflict(schema.GroupResource{Resource: "configmaps"}, storeName, errors.New("stale"))
		}
		return cl.Update(context.Background(), obj)
	})
	if err := r.store.PutTemplate(ctx, TemplateRequest{Name: "extra", PerGPUCount: []int32{1}, Spec: json.RawMessage(storeSpec)}); err != nil {
		t.Fatal(err)
	}
	if conflicts != 1 || !r.ciExists(t, "e2b-extra-g1") {
		t.Fatalf("conflicts=%d", conflicts)
	}
}

func TestOwnerPolicyStoreOnlyLeaderRegistersTemplates(t *testing.T) {
	ctx := context.Background()
	r := newStoreRig(t, storePolicy, nil)
	r.leader.Store(false)
	if err := r.store.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if r.ciExists(t, "e2b-runner-g1") || r.appliedTemplates() != "e2b-runner-g1" {
		t.Fatalf("follower sync: ci=%v applied=%s", r.ciExists(t, "e2b-runner-g1"), r.appliedTemplates())
	}
	if err := r.store.PutTemplate(ctx, TemplateRequest{Name: "extra", PerGPUCount: []int32{1}, Spec: json.RawMessage(storeSpec)}); err != nil {
		t.Fatal(err)
	}
	if r.ciExists(t, "e2b-extra-g1") {
		t.Fatal("follower registered a template")
	}
	r.leader.Store(true)
	if err := r.store.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if !r.ciExists(t, "e2b-runner-g1") || !r.ciExists(t, "e2b-extra-g1") {
		t.Fatal("new leader did not register the stored templates")
	}
}

func TestOwnerPolicyStoreMarkAppliedSkipsStartupApply(t *testing.T) {
	r := newStoreRig(t, storePolicy, nil)
	r.leader.Store(false)
	r.store.MarkApplied(storePolicy)
	if err := r.store.Sync(context.Background()); err != nil {
		t.Fatal(err)
	}
	if r.svc.owner.Load() != nil {
		t.Fatal("sync re-applied the policy applied at startup")
	}
}

func TestOwnerPolicyStoreSyncAppliesAndRetriesRejected(t *testing.T) {
	ctx := context.Background()
	r := newStoreRig(t, storePolicy, nil)
	now := time.Now()
	r.store.now = func() time.Time { return now }
	if err := r.store.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	r.setStored(t, `{"templates":[{"name":"other","perGpuCount":[1],"spec":`+storeSpec+`}]}`)
	if err := r.store.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if !r.ciExists(t, "e2b-other-g1") || r.ciExists(t, "e2b-runner-g1") {
		t.Fatal("sync did not apply the changed policy")
	}

	r.setStored(t, `{"templates":[]}`)
	if err := r.store.Sync(ctx); err == nil {
		t.Fatal("sync accepted a policy without templates")
	}
	out, err := r.store.Templates(ctx)
	if err != nil || out.InSync || out.Error == "" {
		t.Fatalf("status of a rejected policy: %+v %v", out, err)
	}
	if err := r.store.Sync(ctx); err != nil {
		t.Fatalf("a rejected policy was retried at once: %v", err)
	}
	now = now.Add(rejectedPolicyRetry)
	if err := r.store.Sync(ctx); err == nil {
		t.Fatal("a rejected policy was not retried after the wait")
	}
	if !r.ciExists(t, "e2b-other-g1") {
		t.Fatal("a rejected policy removed the applied templates")
	}
}

func TestOwnerPolicyStoreRefusesTemplatesKeyInOtherCase(t *testing.T) {
	r := newStoreRig(t, `{"Templates":[{"name":"runner","perGpuCount":[1],"spec":`+storeSpec+`}]}`, nil)
	if _, err := r.store.Templates(context.Background()); err == nil {
		t.Fatal("list accepted a Templates field")
	}
	err := r.store.PutTemplate(context.Background(), TemplateRequest{Name: "extra", PerGPUCount: []int32{1}, Spec: json.RawMessage(storeSpec)})
	if err == nil {
		t.Fatal("put accepted a Templates field")
	}
}
