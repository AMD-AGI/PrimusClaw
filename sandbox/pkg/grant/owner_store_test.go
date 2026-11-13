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
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

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

func newStoreRig(t *testing.T, policy string) (*OwnerPolicyStore, *Service, ctrlclient.Client) {
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
	cl := fake.NewClientBuilder().WithScheme(scheme).WithObjects(cm).
		WithStatusSubresource(&runtimev1alpha1.SandboxGrant{}).Build()
	svc := New(Options{Client: cl, Namespace: storeNS})
	return NewOwnerPolicyStore(cl, cl, storeNS, storeName, svc), svc, cl
}

func storedPolicy(t *testing.T, cl ctrlclient.Client) map[string]json.RawMessage {
	t.Helper()
	cm := &corev1.ConfigMap{}
	if err := cl.Get(context.Background(), types.NamespacedName{Namespace: storeNS, Name: storeName}, cm); err != nil {
		t.Fatal(err)
	}
	var doc map[string]json.RawMessage
	if err := json.Unmarshal([]byte(cm.Data[OwnerPolicyKey]), &doc); err != nil {
		t.Fatal(err)
	}
	return doc
}

func ciExists(t *testing.T, cl ctrlclient.Client, name string) bool {
	t.Helper()
	err := cl.Get(context.Background(), types.NamespacedName{Namespace: storeNS, Name: name}, &runtimev1alpha1.CodeInterpreter{})
	return err == nil
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
	store, svc, cl := newStoreRig(t, storePolicy)
	if err := store.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if !ciExists(t, cl, "e2b-runner-g1") {
		t.Fatal("startup sync did not register the policy template")
	}

	err := store.PutTemplate(ctx, TemplateRequest{Name: "extra", PerGPUCount: []int32{1}, Spec: json.RawMessage(storeSpec)})
	if err != nil {
		t.Fatal(err)
	}
	if !ciExists(t, cl, "e2b-extra-g1") {
		t.Fatal("put did not register the new template")
	}
	if !strings.Contains(strings.Join(svc.owner.Load().roleSpec, ","), "e2b-extra-g1") {
		t.Fatalf("applied role templates %v", svc.owner.Load().roleSpec)
	}
	doc := storedPolicy(t, cl)
	var quota bytes.Buffer
	if err := json.Compact(&quota, doc["default"]); err != nil || quota.String() != `{"maxSandboxes":2}` {
		t.Fatalf("default quota rewritten: %s", doc["default"])
	}
	templates, err := store.Templates(ctx)
	if err != nil || len(templates) != 2 || templates[1].Name != "extra" {
		t.Fatalf("templates=%v err=%v", templates, err)
	}

	if err := store.DeleteTemplate(ctx, "extra"); err != nil {
		t.Fatal(err)
	}
	if ciExists(t, cl, "e2b-extra-g1") {
		t.Fatal("delete kept the dropped template")
	}
	if err := store.DeleteTemplate(ctx, "extra"); opStatus(err) != http.StatusNotFound {
		t.Fatalf("delete missing: %v", err)
	}
	if err := store.DeleteTemplate(ctx, "runner"); opStatus(err) != http.StatusBadRequest {
		t.Fatalf("delete last: %v", err)
	}
}

func TestOwnerPolicyStoreReplacesTemplate(t *testing.T) {
	ctx := context.Background()
	store, _, cl := newStoreRig(t, storePolicy)
	err := store.PutTemplate(ctx, TemplateRequest{Name: "runner", PerGPUCount: []int32{1, 8}, Spec: json.RawMessage(storeSpec)})
	if err != nil {
		t.Fatal(err)
	}
	templates, err := store.Templates(ctx)
	if err != nil || len(templates) != 1 || len(templates[0].PerGPUCount) != 2 {
		t.Fatalf("templates=%v err=%v", templates, err)
	}
	if !ciExists(t, cl, "e2b-runner-g8") {
		t.Fatal("replaced template did not register the new size")
	}
}

func TestOwnerPolicyStoreRejectsWithoutWriting(t *testing.T) {
	ctx := context.Background()
	store, _, cl := newStoreRig(t, storePolicy)
	before := storedPolicy(t, cl)
	for _, tpl := range []TemplateRequest{
		{Name: "", Spec: json.RawMessage(storeSpec)},
		{Name: "nospec"},
		{Name: "dup", Spec: json.RawMessage(`{"fromImage":`)},
	} {
		if err := store.PutTemplate(ctx, tpl); err == nil {
			t.Fatalf("put %q accepted", tpl.Name)
		}
	}
	after := storedPolicy(t, cl)
	if string(before["templates"]) != string(after["templates"]) {
		t.Fatalf("rejected put changed the ConfigMap: %s", after["templates"])
	}
}

func TestOwnerPolicyStoreSyncAppliesExternalChange(t *testing.T) {
	ctx := context.Background()
	store, _, cl := newStoreRig(t, storePolicy)
	if err := store.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	cm := &corev1.ConfigMap{}
	if err := cl.Get(ctx, types.NamespacedName{Namespace: storeNS, Name: storeName}, cm); err != nil {
		t.Fatal(err)
	}
	cm.Data[OwnerPolicyKey] = `{"templates":[{"name":"other","perGpuCount":[1],"spec":` + storeSpec + `}]}`
	if err := cl.Update(ctx, cm); err != nil {
		t.Fatal(err)
	}
	if err := store.Sync(ctx); err != nil {
		t.Fatal(err)
	}
	if !ciExists(t, cl, "e2b-other-g1") || ciExists(t, cl, "e2b-runner-g1") {
		t.Fatal("sync did not apply the changed policy")
	}

	cm.Data[OwnerPolicyKey] = `{"templates":[]}`
	if err := cl.Update(ctx, cm); err != nil {
		t.Fatal(err)
	}
	if err := store.Sync(ctx); err == nil {
		t.Fatal("sync accepted a policy without templates")
	}
	if err := store.Sync(ctx); err != nil {
		t.Fatalf("a rejected policy is retried before it changes: %v", err)
	}
	if !ciExists(t, cl, "e2b-other-g1") {
		t.Fatal("a rejected policy removed the applied templates")
	}
}
