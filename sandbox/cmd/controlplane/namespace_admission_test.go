// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"

	"sigs.k8s.io/agent-sandbox/pkg/nsadmission"
	"sigs.k8s.io/agent-sandbox/pkg/router"
	"sigs.k8s.io/agent-sandbox/pkg/workloadmanager"
)

// The chart passes the selector only through NAMESPACE_SELECTOR, so that is
// the value the process must enforce, over the flag.
func TestNamespaceSelectorFromEnvReadsTheChartVariable(t *testing.T) {
	t.Setenv(nsadmission.EnvVar, "example.com/sandbox=enabled")
	sel, err := namespaceSelectorFromEnv("from-flag=x")
	if err != nil {
		t.Fatal(err)
	}
	if sel == nil || sel.String() != "example.com/sandbox=enabled" {
		t.Fatalf("selector = %v, want the NAMESPACE_SELECTOR value", sel)
	}
}

func TestNamespaceSelectorFromEnvFallsBackToTheFlag(t *testing.T) {
	t.Setenv(nsadmission.EnvVar, "")
	sel, err := namespaceSelectorFromEnv("from-flag=x")
	if err != nil || sel == nil || sel.String() != "from-flag=x" {
		t.Fatalf("selector = %v, err = %v, want the flag value", sel, err)
	}
	if sel, err := namespaceSelectorFromEnv(""); err != nil || sel != nil {
		t.Fatalf("nothing set: selector = %v, err = %v, want nil, nil", sel, err)
	}
}

// A typo must stop the process, never degrade to admitting every namespace
// while the chart has already rendered the static prefix Ingress.
func TestNamespaceSelectorFromEnvRefusesAnInvalidSelector(t *testing.T) {
	t.Setenv(nsadmission.EnvVar, "a in (")
	if sel, err := namespaceSelectorFromEnv(""); err == nil {
		t.Fatalf("invalid selector accepted as %v", sel)
	}
}

// Both servers must enforce the same Admitter: the Router for invocations and
// the Workload Manager for creates proxied through the Router.
func TestWireNamespaceAdmissionSetsRouterAndWorkloadManager(t *testing.T) {
	sel, err := nsadmission.ParseSelector("example.com/sandbox=enabled")
	if err != nil {
		t.Fatal(err)
	}
	client := fake.NewClientset(
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "admitted", Labels: map[string]string{"example.com/sandbox": "enabled"}}},
		&corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: "denied"}},
	)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	var rc router.Config
	var wc workloadmanager.Config
	a := wireNamespaceAdmission(ctx, client, sel, &rc, &wc)
	if a == nil || rc.Namespaces != a || wc.Namespaces != a {
		t.Fatalf("admitter %p not wired: router=%p wm=%p", a, rc.Namespaces, wc.Namespaces)
	}
	// Started: it syncs and answers without anyone else calling Start.
	deadline := time.Now().Add(10 * time.Second)
	for !a.Ready() {
		if time.Now().After(deadline) {
			t.Fatal("wired admitter was never started")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if d := a.Admit("denied"); d != nsadmission.NotAdmitted {
		t.Fatalf("denied namespace: %v", d)
	}
	if d := a.Admit("admitted"); d != nsadmission.Admitted {
		t.Fatalf("admitted namespace: %v", d)
	}

	var rc2 router.Config
	var wc2 workloadmanager.Config
	if a := wireNamespaceAdmission(ctx, client, nil, &rc2, &wc2); a != nil || rc2.Namespaces != nil || wc2.Namespaces != nil {
		t.Fatal("no selector must leave admission off")
	}
}
