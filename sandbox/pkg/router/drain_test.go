// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package router

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"sigs.k8s.io/agent-sandbox/pkg/store"
)

// drainFixture is a Router serving /health/ready and a port-proxy route (the
// path Hands MCP calls take) to a sandbox stand-in on loopback.
type drainFixture struct {
	s      *Server
	base   string
	served chan error
	cancel context.CancelFunc
}

func newDrainFixture(t *testing.T, upstream *httptest.Server, cfg Config) *drainFixture {
	t.Helper()
	wm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(wm.Close)

	u, err := url.Parse(upstream.URL)
	require.NoError(t, err)
	port, err := strconv.Atoi(u.Port())
	require.NoError(t, err)
	info := &store.SandboxInfo{SessionID: "drain-test", PodIP: "127.0.0.1"}

	cfg.WorkloadManagerURL = wm.URL
	s := newReadinessServer(t, wm.URL)
	s.cfg = cfg
	s.engine.Any("/proxy/*rest", func(c *gin.Context) {
		s.handlePortProxy(c, info, port, c.Param("rest"))
	})

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(context.Background())
	f := &drainFixture{s: s, base: "http://" + ln.Addr().String(), served: make(chan error, 1), cancel: cancel}
	go func() { f.served <- s.Serve(ctx, ln) }()
	t.Cleanup(cancel)
	return f
}

func (f *drainFixture) status(t *testing.T, path string) int {
	t.Helper()
	resp, err := (&http.Client{Timeout: 2 * time.Second}).Get(f.base + path)
	require.NoError(t, err)
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	return resp.StatusCode
}

type proxied struct {
	code int
	body string
	err  error
}

func startProxied(f *drainFixture) <-chan proxied {
	out := make(chan proxied, 1)
	go func() {
		resp, err := (&http.Client{Timeout: 10 * time.Second}).Post(f.base+"/proxy/mcp", "application/json", nil)
		if err != nil {
			out <- proxied{err: err}
			return
		}
		defer resp.Body.Close()
		b, err := io.ReadAll(resp.Body)
		out <- proxied{code: resp.StatusCode, body: string(b), err: err}
	}()
	return out
}

// The 2026-10-10 rollout: a SIGTERM arrives while a long proxied request is in
// flight. Readiness must fail at once, new requests must still be accepted
// during the delay, and the in-flight request must complete, not be cut.
func TestDrainKeepsInFlightProxyAndFailsReadiness(t *testing.T) {
	arrived := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(arrived)
		<-release
		io.WriteString(w, "mcp-done")
	}))
	defer upstream.Close()
	// Runs before upstream.Close on a failed assertion, which would otherwise
	// wait forever for the held handler.
	defer releaseOnce.Do(func() { close(release) })

	f := newDrainFixture(t, upstream, Config{ShutdownDelay: 500 * time.Millisecond, ShutdownTimeout: 5 * time.Second})
	require.Equal(t, http.StatusOK, f.status(t, "/health/ready"), "ready before the signal")

	result := startProxied(f)
	<-arrived

	f.cancel() // SIGTERM
	require.Eventually(t, func() bool { return f.s.draining.Load() }, time.Second, 5*time.Millisecond)
	assert.Equal(t, http.StatusServiceUnavailable, f.status(t, "/health/ready"),
		"readiness must fail while draining")
	assert.Equal(t, http.StatusOK, f.status(t, "/health/live"),
		"the listener stays open during the shutdown delay")

	// Hold the request past the delay so it is still in flight when the
	// listener closes and Shutdown starts waiting.
	time.Sleep(700 * time.Millisecond)
	select {
	case err := <-f.served:
		t.Fatalf("Serve returned with a request in flight: %v", err)
	default:
	}
	releaseOnce.Do(func() { close(release) })

	r := <-result
	require.NoError(t, r.err, "the in-flight proxied request must survive the drain")
	assert.Equal(t, http.StatusOK, r.code)
	assert.Equal(t, "mcp-done", r.body)

	select {
	case err := <-f.served:
		assert.NoError(t, err)
	case <-time.After(3 * time.Second):
		t.Fatal("Serve did not return after the last request finished")
	}
	_, err := (&http.Client{Timeout: time.Second}).Get(f.base + "/health/live")
	assert.Error(t, err, "the listener is closed once the drain completes")
}

// The drain is bounded: a stream that never ends is closed at ShutdownTimeout
// instead of holding the Pod until kubelet's SIGKILL.
func TestDrainIsBoundedByShutdownTimeout(t *testing.T) {
	arrived := make(chan struct{})
	stop := make(chan struct{})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(arrived)
		select {
		case <-stop:
		case <-r.Context().Done():
		}
	}))
	defer upstream.Close()
	defer close(stop)

	f := newDrainFixture(t, upstream, Config{ShutdownTimeout: 300 * time.Millisecond})
	result := startProxied(f)
	<-arrived

	start := time.Now()
	f.cancel()
	select {
	case err := <-f.served:
		assert.NoError(t, err)
	case <-time.After(3 * time.Second):
		t.Fatal("Serve ignored ShutdownTimeout")
	}
	assert.GreaterOrEqual(t, time.Since(start), 300*time.Millisecond, "the drain waited for the request")
	r := <-result
	assert.Error(t, r.err, "the stream still open at the timeout is closed")
}
