// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package router

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

func proxyToWMOnce(t *testing.T, wmURL, method, path string) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	s := &Server{cfg: Config{WorkloadManagerURL: wmURL}}
	rec := httptest.NewRecorder()
	c, _ := gin.CreateTestContext(rec)
	c.Request = httptest.NewRequest(method, path, strings.NewReader(`{}`))
	s.proxyToWM(c)
	return rec
}

// A Workload Manager that holds a create past the gateway's deadline has not
// gone away: the sandbox is still being placed there. The gateway says so
// instead of reporting the Workload Manager unreachable.
func TestProxyToWMTimeoutSaysStillPending(t *testing.T) {
	release := make(chan struct{})
	wm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(wm.Close)
	t.Cleanup(func() { close(release) })
	prev := httpClient
	httpClient = &http.Client{Timeout: 50 * time.Millisecond}
	t.Cleanup(func() { httpClient = prev })

	rec := proxyToWMOnce(t, wm.URL, http.MethodPost, "/v2/sandboxes")
	if rec.Code != http.StatusGatewayTimeout {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	message, _ := body["message"].(string)
	if body["reason"] != "upstream_timeout" || !strings.Contains(message, "the sandbox is still pending") ||
		strings.Contains(rec.Body.String(), "unreachable") {
		t.Fatalf("body=%s", rec.Body.String())
	}

	rec = proxyToWMOnce(t, wm.URL, http.MethodGet, "/v1/templates")
	if rec.Code != http.StatusGatewayTimeout || strings.Contains(rec.Body.String(), "sandbox is still pending") ||
		strings.Contains(rec.Body.String(), "unreachable") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

// A Workload Manager that refuses the connection is still reported unreachable.
func TestProxyToWMRefusedConnectionIsUnreachable(t *testing.T) {
	wm := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	addr := wm.URL
	wm.Close()
	rec := proxyToWMOnce(t, addr, http.MethodPost, "/v2/sandboxes")
	if rec.Code != http.StatusBadGateway || !strings.Contains(rec.Body.String(), "workload manager unreachable") {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestIsTimeoutLeavesDialFailuresUnreachable(t *testing.T) {
	dial := &net.OpError{Op: "dial", Net: "tcp", Err: timeoutErr{}}
	if isTimeout(&url.Error{Op: "Post", URL: "http://wm", Err: dial}) {
		t.Fatal("a dial timeout never reached the workload manager")
	}
	if !isTimeout(&url.Error{Op: "Post", URL: "http://wm", Err: &net.OpError{Op: "read", Net: "tcp", Err: timeoutErr{}}}) {
		t.Fatal("a read timeout is the workload manager not answering")
	}
}

type timeoutErr struct{}

func (timeoutErr) Error() string   { return "i/o timeout" }
func (timeoutErr) Timeout() bool   { return true }
func (timeoutErr) Temporary() bool { return true }
