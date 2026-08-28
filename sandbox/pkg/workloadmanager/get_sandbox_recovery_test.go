// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// The keepalive GET rebuilds a session from its Sandbox CR when the store has
// lost the record. The rebuild is lossy -- the CR cannot reproduce the egress
// policy or the inference key -- and it writes, so two things decide whether it
// helps or harms: it must fire only for a record that is confirmed absent, and
// it must not write before the caller is authorised. These tests pin both.
//
// Each builds its own store and client and shares no state, so they run in parallel.
package workloadmanager

import (
	"context"
	"errors"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	sandboxv1alpha1 "sigs.k8s.io/agent-sandbox/api/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/store"
)

const (
	recoverySession = "keepalive-session"
	recoveryOwner   = "owner-1"
)

// recoveryTestStore forces a read failure and counts writes, which is what
// separates "answered the caller" from "overwrote the record".
type recoveryTestStore struct {
	store.Store
	getErr error
	writes int
}

func (s *recoveryTestStore) GetSandboxBySessionID(ctx context.Context, sessionID string) (*store.SandboxInfo, error) {
	if s.getErr != nil {
		return nil, s.getErr
	}
	return s.Store.GetSandboxBySessionID(ctx, sessionID)
}

func (s *recoveryTestStore) StoreSandbox(ctx context.Context, info *store.SandboxInfo) error {
	s.writes++
	return s.Store.StoreSandbox(ctx, info)
}

// ownedSandbox carries the two things recovery reads: a resolvable address, so
// it does not fall through to a Pod lookup, and an owner to authorise against.
func ownedSandbox(sessionID, ownerID string) *sandboxv1alpha1.Sandbox {
	return &sandboxv1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{
			Name:        "sandbox-under-test",
			Namespace:   "default",
			Annotations: map[string]string{sessionIDAnnotationKey: sessionID},
			Labels:      map[string]string{userIDLabelKey: ownerID},
		},
		Status: sandboxv1alpha1.SandboxStatus{
			ServiceFQDN: "sandbox-under-test.default.svc.cluster.local",
		},
	}
}

// getSandboxAs runs the handler as the given caller. An empty user id is the
// no-auth deployment, where the tenant boundary is intentionally absent.
func getSandboxAs(t *testing.T, s *Server, userID, role string) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest("GET", "/v1/code-interpreter/sessions/"+recoverySession, nil)
	if userID != "" {
		c.Request.Header.Set(UserIDHeader, userID)
		c.Request.Header.Set(UserRoleHeader, role)
	}
	c.Params = gin.Params{{Key: "sessionId", Value: recoverySession}}
	s.handleGetSandbox(c)
	return rec
}

// TestGetSandboxDoesNotRebuildOnAnUnreadableStore is the one that matters: a
// Redis timeout does not mean the record is gone, and rebuilding on one replaces
// a complete record with the subset the CR can reproduce. The policy fields are
// the evidence -- an emptied RuntimePolicy falls through the engine's switch to
// agent-default, so an agent-restricted sandbox silently loses egress confinement.
func TestGetSandboxDoesNotRebuildOnAnUnreadableStore(t *testing.T) {
	t.Parallel()
	base := store.NewMemoryStore()
	complete := &store.SandboxInfo{
		SessionID:          recoverySession,
		SandboxName:        "sandbox-under-test",
		Namespace:          "default",
		UserID:             recoveryOwner,
		RuntimePolicy:      "agent-restricted",
		PolicyMode:         "enforce",
		AllowedEgressHosts: []string{"api.internal.example"},
		InferenceApiKey:    "sk-do-not-lose-me",
	}
	if err := base.StoreSandbox(context.Background(), complete); err != nil {
		t.Fatalf("seed store: %v", err)
	}

	st := &recoveryTestStore{Store: base, getErr: errors.New("redis GET: i/o timeout")}
	s := &Server{store: st, k8s: &K8sSandboxCreator{
		client:       indexedClient(t, ownedSandbox(recoverySession, recoveryOwner)),
		cachedReader: indexedClient(t, ownedSandbox(recoverySession, recoveryOwner)),
	}}

	rec := getSandboxAs(t, s, recoveryOwner, RoleDefault)

	if rec.Code != 503 {
		t.Errorf("unreadable store: got %d, want 503", rec.Code)
	}
	if st.writes != 0 {
		t.Errorf("wrote %d times; an unreadable store must not trigger a rebuild", st.writes)
	}
	kept, err := base.GetSandboxBySessionID(context.Background(), recoverySession)
	if err != nil {
		t.Fatalf("record must survive: %v", err)
	}
	if kept.RuntimePolicy != "agent-restricted" || kept.InferenceApiKey != "sk-do-not-lose-me" {
		t.Errorf("record was overwritten by a rebuild: policy=%q key=%q",
			kept.RuntimePolicy, kept.InferenceApiKey)
	}
	if len(kept.AllowedEgressHosts) != 1 {
		t.Errorf("egress whitelist lost: %v", kept.AllowedEgressHosts)
	}
}

// TestGetSandboxAuthorisesBeforeRestoringARebuild pins the ordering against
// handleRecoverSession, which already checks first. Writing before the check
// lets anyone who knows a session id trigger a write on someone else's record
// and only then be refused, so the refusal arrives after the damage.
func TestGetSandboxAuthorisesBeforeRestoringARebuild(t *testing.T) {
	t.Parallel()
	st := &recoveryTestStore{Store: store.NewMemoryStore()} // empty: a genuine ErrNotFound
	s := &Server{store: st, k8s: &K8sSandboxCreator{
		client:       indexedClient(t, ownedSandbox(recoverySession, recoveryOwner)),
		cachedReader: indexedClient(t, ownedSandbox(recoverySession, recoveryOwner)),
	}}

	rec := getSandboxAs(t, s, "intruder", RoleDefault)

	if rec.Code != 403 {
		t.Errorf("foreign caller: got %d, want 403", rec.Code)
	}
	if st.writes != 0 {
		t.Errorf("wrote %d times before refusing the caller", st.writes)
	}
}

// TestGetSandboxRestoresARebuildForItsOwner keeps the behaviour the rebuild
// exists for: the owner still gets an answer and the record comes back, so the
// next keepalive has somewhere to land.
func TestGetSandboxRestoresARebuildForItsOwner(t *testing.T) {
	t.Parallel()
	base := store.NewMemoryStore()
	st := &recoveryTestStore{Store: base}
	s := &Server{store: st, k8s: &K8sSandboxCreator{
		client:       indexedClient(t, ownedSandbox(recoverySession, recoveryOwner)),
		cachedReader: indexedClient(t, ownedSandbox(recoverySession, recoveryOwner)),
	}}

	rec := getSandboxAs(t, s, recoveryOwner, RoleDefault)

	if rec.Code != 200 {
		t.Fatalf("owner: got %d, want 200 (body %s)", rec.Code, rec.Body.String())
	}
	if st.writes != 1 {
		t.Errorf("restored %d times, want 1", st.writes)
	}
	restored, err := base.GetSandboxBySessionID(context.Background(), recoverySession)
	if err != nil {
		t.Fatalf("record must be back in the store: %v", err)
	}
	if restored.UserID != recoveryOwner {
		t.Errorf("owner lost in the rebuild: %q", restored.UserID)
	}
}
