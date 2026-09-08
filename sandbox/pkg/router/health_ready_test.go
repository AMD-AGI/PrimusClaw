// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package router

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/prometheus/client_golang/prometheus/testutil"
	"github.com/stretchr/testify/assert"

	"sigs.k8s.io/agent-sandbox/pkg/store"
)

// newReadinessServer wires just enough Server to exercise /health/ready against
// a stand-in Workload Manager.
func newReadinessServer(t *testing.T, wmURL string) *Server {
	t.Helper()
	gin.SetMode(gin.TestMode)

	s := &Server{
		cfg:   Config{WorkloadManagerURL: wmURL},
		store: store.NewMemoryStore(),
	}
	s.engine = gin.New()
	s.engine.Use(gin.Recovery())
	s.engine.GET("/health/ready", s.handleHealthReady)
	s.engine.GET("/health/live", s.handleHealthLive)
	return s
}

func get(t *testing.T, s *Server, path string) *httptest.ResponseRecorder {
	t.Helper()
	w := httptest.NewRecorder()
	s.engine.ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
	return w
}

func failures(check, reason string) float64 {
	return testutil.ToFloat64(readinessFailures.WithLabelValues(check, reason))
}

func TestReadyReportsWorkloadManagerHealthy(t *testing.T) {
	wm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer wm.Close()

	s := newReadinessServer(t, wm.URL)
	w := get(t, s, "/health/ready")

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Equal(t, float64(1), testutil.ToFloat64(routerReady))
}

// The failure this whole change exists to make visible: the Workload Manager
// answering something other than 200. Before, the reason went into a response
// body that kubelet throws away, so nothing recorded which check failed.
func TestNotReadyRecordsWhichCheckFailed(t *testing.T) {
	before := failures("workload_manager", "status")

	wm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer wm.Close()

	s := newReadinessServer(t, wm.URL)
	w := get(t, s, "/health/ready")

	assert.Equal(t, http.StatusServiceUnavailable, w.Code)
	assert.Contains(t, w.Body.String(), "workload-manager")
	assert.Equal(t, float64(0), testutil.ToFloat64(routerReady))
	assert.Equal(t, before+1, failures("workload_manager", "status"))
}

// A Workload Manager that is not listening must classify as "refused" rather
// than landing in the catch-all: connection refused and a hang are different
// faults and the 2026-09-06 outage could not be told apart from the outside.
func TestNotReadyClassifiesRefused(t *testing.T) {
	// Bind and immediately close, so the port is real and certainly closed.
	l := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := l.URL
	l.Close()

	before := failures("workload_manager", "refused")
	s := newReadinessServer(t, url)
	w := get(t, s, "/health/ready")

	assert.Equal(t, http.StatusServiceUnavailable, w.Code)
	assert.Equal(t, before+1, failures("workload_manager", "refused"),
		"a closed port must be classified as refused")
}

// The probe must not outlive itself. http.Get, which this replaced, had no
// timeout at all: a hung Workload Manager left one orphaned request per probe.
func TestNotReadyTimesOutOnHungWorkloadManager(t *testing.T) {
	release := make(chan struct{})
	wm := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		<-release
	}))
	defer func() { close(release); wm.Close() }()

	s := newReadinessServer(t, wm.URL)

	start := time.Now()
	w := get(t, s, "/health/ready")
	elapsed := time.Since(start)

	assert.Equal(t, http.StatusServiceUnavailable, w.Code)
	assert.Less(t, elapsed, 3*time.Second,
		"must give up on its own rather than hang until the caller does")
}

// Liveness stays deliberately unconditional -- this pins that fact so the
// asymmetry is a decision on the record rather than an oversight. It is also
// why a not-ready controlplane never restarts itself: see router.ready.lost.
func TestLiveIsUnconditional(t *testing.T) {
	l := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	url := l.URL
	l.Close() // Workload Manager definitively unreachable

	s := newReadinessServer(t, url)
	assert.Equal(t, http.StatusServiceUnavailable, get(t, s, "/health/ready").Code)
	assert.Equal(t, http.StatusOK, get(t, s, "/health/live").Code,
		"liveness does not consult the Workload Manager, so a not-ready pod is never restarted")
}
