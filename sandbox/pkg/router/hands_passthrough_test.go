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

// handsCall sends a request to the port proxy of port on the managing Router.
func handsCall(t *testing.T, p *forwardPair, port int, handsToken string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet,
		p.front.URL+"/v1/namespaces/crusoe-ws/code-interpreters/"+forwardSession+
			"/invocations/proxy/"+strconv.Itoa(port)+"/mcp", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("x-session-id", forwardSession)
	req.Header.Set("Authorization", "Bearer "+handsToken)
	if handsToken != "" {
		req.Header.Set(HandsTokenHeader, handsToken)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(body)
}

// newHandsPair is a forward pair whose identity refuses every credential and whose
// sandbox serves Hands on a test port.
func newHandsPair(t *testing.T) (*forwardPair, *atomic.Value, *atomic.Value) {
	t.Helper()
	gotToken, gotAuth := &atomic.Value{}, &atomic.Value{}
	hands := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotToken.Store(r.Header.Get(HandsTokenHeader))
		gotAuth.Store(r.Header.Get("Authorization"))
		_, _ = w.Write([]byte("from-hands"))
	}))
	t.Cleanup(hands.Close)
	saved := handsPort
	handsPort = envdPort(t, hands)
	t.Cleanup(func() { handsPort = saved })

	p := newForwardPair(t, "u1")
	refuse := httptest.NewServer(http.HandlerFunc(inactiveAnswer))
	t.Cleanup(refuse.Close)
	p.global.cfg.Identity = identity.NewClient(refuse.URL, "agent-sandbox", "secret", "")
	return p, gotToken, gotAuth
}

func TestHandsPassthroughNeedsNoPlatformKey(t *testing.T) {
	p, gotToken, gotAuth := newHandsPair(t)
	status, body := handsCall(t, p, handsPort, "hands-secret")
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

func TestHandsPassthroughRequiresHandsToken(t *testing.T) {
	p, _, _ := newHandsPair(t)
	status, body := handsCall(t, p, handsPort, "")
	if status != http.StatusUnauthorized {
		t.Fatalf("status=%d body=%s", status, body)
	}
}

func TestHandsPassthroughIsOnlyTheHandsPort(t *testing.T) {
	p, _, _ := newHandsPair(t)
	status, body := handsCall(t, p, handsPort+1, "hands-secret")
	if status != http.StatusUnauthorized || errorCode(body) != "caller_credential_invalid" {
		t.Fatalf("status=%d body=%s", status, body)
	}
}
