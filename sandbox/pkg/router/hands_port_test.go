// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package router

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"

	"sigs.k8s.io/agent-sandbox/pkg/identity"
)

const testHandsTokenHeader = "X-Hands-Token"

// handsCall sends a port proxy request to port on the managing Router.
func handsCall(t *testing.T, p *forwardPair, port int, authorization, handsToken string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet,
		p.front.URL+"/v1/namespaces/crusoe-ws/code-interpreters/"+forwardSession+
			"/invocations/proxy/"+strconv.Itoa(port)+"/mcp", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("x-session-id", forwardSession)
	if authorization != "" {
		req.Header.Set("Authorization", "Bearer "+authorization)
	}
	if handsToken != "" {
		req.Header.Set(testHandsTokenHeader, handsToken)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body)
}

// newHandsPair is a forward pair whose sandbox serves Hands on a test port.
func newHandsPair(t *testing.T) (*forwardPair, int, *atomic.Value, *atomic.Value) {
	t.Helper()
	gotToken, gotAuth := &atomic.Value{}, &atomic.Value{}
	hands := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotToken.Store(r.Header.Get(testHandsTokenHeader))
		gotAuth.Store(r.Header.Get("Authorization"))
		_, _ = w.Write([]byte("from-hands"))
	}))
	t.Cleanup(hands.Close)
	return newForwardPair(t, "u1"), envdPort(t, hands), gotToken, gotAuth
}

func TestHandsTokenAloneIsNotACallerCredential(t *testing.T) {
	p, port, _, _ := newHandsPair(t)
	refuse := httptest.NewServer(http.HandlerFunc(inactiveAnswer))
	t.Cleanup(refuse.Close)
	p.global.cfg.Identity = identity.NewClient(refuse.URL, "agent-sandbox", "secret", "")

	status, body := handsCall(t, p, port, "", "hands-secret")
	if status != http.StatusUnauthorized || errorCode(body) != "caller_credentials_missing" {
		t.Fatalf("status=%d body=%s", status, body)
	}
	status, body = handsCall(t, p, port, "hands-secret", "hands-secret")
	if status != http.StatusUnauthorized || errorCode(body) != "caller_credential_invalid" {
		t.Fatalf("status=%d body=%s", status, body)
	}
}

func TestHandsCallWithPlatformKeyReachesHands(t *testing.T) {
	p, port, gotToken, gotAuth := newHandsPair(t)
	status, body := handsCall(t, p, port, "ak-owner", "hands-secret")
	if status != http.StatusOK || body != "from-hands" {
		t.Fatalf("status=%d body=%s", status, body)
	}
	if tok, _ := gotToken.Load().(string); tok != "hands-secret" {
		t.Fatalf("hands token=%q", tok)
	}
	if auth, _ := gotAuth.Load().(string); auth != "" {
		t.Fatalf("Authorization reached Hands: %q", auth)
	}
}

func TestHandsCallByNonOwnerIsForbidden(t *testing.T) {
	p, port, _, _ := newHandsPair(t)
	other := httptest.NewServer(introspectAnswer("u2", "u2@example.com"))
	t.Cleanup(other.Close)
	p.global.cfg.Identity = identity.NewClient(other.URL, "agent-sandbox", "secret", "")

	status, body := handsCall(t, p, port, "ak-other", "hands-secret")
	if status != http.StatusForbidden || errorCode(body) != "caller_not_session_owner" {
		t.Fatalf("status=%d body=%s", status, body)
	}
}
