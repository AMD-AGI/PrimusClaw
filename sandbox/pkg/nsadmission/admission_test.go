// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package nsadmission

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

func namespace(name string, lbls map[string]string) *corev1.Namespace {
	return &corev1.Namespace{ObjectMeta: metav1.ObjectMeta{Name: name, Labels: lbls}}
}

// started returns a synced Admitter over a fake API server holding nss.
func started(t *testing.T, selector string, nss ...*corev1.Namespace) *Admitter {
	t.Helper()
	sel, err := ParseSelector(selector)
	if err != nil {
		t.Fatal(err)
	}
	client := fake.NewClientset()
	for _, ns := range nss {
		if _, err := client.CoreV1().Namespaces().Create(context.Background(), ns, metav1.CreateOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	a := New(client, sel)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	a.Start(ctx)
	deadline := time.Now().Add(10 * time.Second)
	for !a.Ready() {
		if time.Now().After(deadline) {
			t.Fatal("namespace informer did not sync")
		}
		time.Sleep(10 * time.Millisecond)
	}
	return a
}

func TestParseSelector(t *testing.T) {
	for _, s := range []string{"", "   "} {
		sel, err := ParseSelector(s)
		if err != nil || sel != nil {
			t.Fatalf("ParseSelector(%q) = %v, %v; want nil, nil", s, sel, err)
		}
	}
	if _, err := ParseSelector("example.com/sandbox=enabled,tier in (a,b)"); err != nil {
		t.Fatalf("valid selector refused: %v", err)
	}
	if _, err := ParseSelector("a=b=c"); err == nil {
		t.Fatal("an unparseable selector must be an error, not admit-all")
	}
}

func TestNilAdmitterAdmitsEverything(t *testing.T) {
	var a *Admitter
	if got := a.Admit("anything"); got != Admitted {
		t.Fatalf("nil admitter: got %v", got)
	}
	if !a.Ready() {
		t.Fatal("nil admitter must be ready")
	}
	if New(fake.NewClientset(), nil) != nil {
		t.Fatal("no selector must yield no admitter")
	}
}

func TestAdmitBySelector(t *testing.T) {
	a := started(t, "example.com/sandbox=enabled",
		namespace("team-a", map[string]string{"example.com/sandbox": "enabled"}),
		namespace("team-b", map[string]string{"example.com/sandbox": "disabled"}),
		namespace("kube-system", nil),
	)
	cases := map[string]Decision{
		"team-a":      Admitted,
		"team-b":      NotAdmitted,
		"kube-system": NotAdmitted,
		"missing":     NotAdmitted,
	}
	for ns, want := range cases {
		if got := a.Admit(ns); got != want {
			t.Errorf("Admit(%q) = %v, want %v", ns, got, want)
		}
	}
}

// The selector is matched again on the cached object, so a decision does not
// depend on the API server having filtered the list.
func TestAdmitRechecksLabelsOnCachedObject(t *testing.T) {
	a := started(t, "example.com/sandbox=enabled",
		namespace("team-a", map[string]string{"example.com/sandbox": "enabled"}))
	if err := a.informer.GetStore().Add(namespace("sneaked-in", nil)); err != nil {
		t.Fatal(err)
	}
	if got := a.Admit("sneaked-in"); got != NotAdmitted {
		t.Fatalf("a cached namespace without the label was %v", got)
	}
}

func TestUnsyncedFailsClosed(t *testing.T) {
	sel, _ := ParseSelector("example.com/sandbox=enabled")
	a := New(fake.NewClientset(
		namespace("team-a", map[string]string{"example.com/sandbox": "enabled"})), sel)
	// Never started, so never synced.
	if a.Ready() {
		t.Fatal("an unstarted admitter reported ready")
	}
	if got := a.Admit("team-a"); got != Unavailable {
		t.Fatalf("unsynced Admit = %v, want unavailable", got)
	}
}

func TestGateStatuses(t *testing.T) {
	gin.SetMode(gin.TestMode)
	synced := started(t, "example.com/sandbox=enabled",
		namespace("team-a", map[string]string{"example.com/sandbox": "enabled"}))
	sel, _ := ParseSelector("example.com/sandbox=enabled")
	unsynced := New(fake.NewClientset(), sel)

	run := func(a *Admitter, ns string) (*httptest.ResponseRecorder, bool) {
		w := httptest.NewRecorder()
		c, _ := gin.CreateTestContext(w)
		c.Request = httptest.NewRequest(http.MethodGet, "/", nil)
		ok := a.Gate(c, ns, "gone")
		return w, ok
	}

	if w, ok := run(synced, "team-a"); !ok || w.Code != http.StatusOK {
		t.Fatalf("admitted: ok=%v code=%d", ok, w.Code)
	}
	if w, ok := run(synced, "other"); ok || w.Code != http.StatusNotFound || w.Body.String() != `{"error":"gone"}` {
		t.Fatalf("not admitted: ok=%v code=%d body=%s", ok, w.Code, w.Body)
	}
	if w, ok := run(unsynced, "team-a"); ok || w.Code != http.StatusServiceUnavailable || w.Header().Get("Retry-After") == "" {
		t.Fatalf("unsynced: ok=%v code=%d", ok, w.Code)
	}
	var none *Admitter
	if _, ok := run(none, "anything"); !ok {
		t.Fatal("nil admitter must pass")
	}
}
