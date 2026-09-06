// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Package router implements the API Gateway / data-plane server for agent-sandbox.
package router

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"k8s.io/client-go/kubernetes"
	"sigs.k8s.io/agent-sandbox/pkg/cmdlog"
	log "sigs.k8s.io/agent-sandbox/pkg/logx"
	"sigs.k8s.io/agent-sandbox/pkg/safe"
	"sigs.k8s.io/agent-sandbox/pkg/store"
)

// Config holds Router configuration.
type Config struct {
	Port                  int
	MaxConcurrentRequests int
	EnableAuth            bool
	SafeAPIURL            string
	WorkloadManagerURL    string
	Namespace             string
}

// DefaultConfig returns sensible defaults.
func DefaultConfig() Config {
	return Config{
		Port:                  8080,
		MaxConcurrentRequests: 1000,
		Namespace:             "default",
	}
}

// Server is the Router HTTP server.
type Server struct {
	cfg            Config
	store          store.Store
	sessionManager SessionManager
	engine         *gin.Engine
	jwt            *JWTManager
	safeClient     *safe.Client // SaFE API Key verification client (nil when auth disabled)

	// Readiness edge tracking, so the log records transitions rather than every
	// probe. Guarded because readiness is served concurrently.
	readyMu        sync.Mutex
	wasReady       bool
	notReadySince  time.Time
	lastUnreadyLog time.Time
}

// New creates a new Router server.
//
// Returns an error rather than a degraded server when the JWT identity cannot
// be reconciled: see EnsureJWTIdentity for why signing with an unverifiable
// key is worse than not starting at all.
func New(
	ctx context.Context,
	cfg Config,
	st store.Store,
	clientset kubernetes.Interface,
) (*Server, error) {
	s := &Server{
		cfg:   cfg,
		store: st,
	}

	// Initialize SaFE API Key client (when auth is enabled)
	if cfg.EnableAuth {
		if cfg.SafeAPIURL == "" {
			log.Error("--enable-auth requires --safe-api-url to be set")
		} else {
			s.safeClient = safe.NewClient(cfg.SafeAPIURL)
			log.Info("SaFE API Key authentication enabled", "safeAPIURL", cfg.SafeAPIURL)
		}
	}

	// Initialize SessionManager
	sm, err := NewSessionManager(st, cfg.WorkloadManagerURL)
	if err != nil {
		log.Warn("SessionManager init failed (WORKLOAD_MANAGER_URL not set?)", "error", err)
	} else {
		s.sessionManager = sm
	}

	// Initialize JWT manager — reconcile the RSA key pair with the Router
	// identity Secret that Workload Manager injects into sandbox Pods.
	mgr, err := NewJWTManager(clientset)
	if err != nil {
		return nil, fmt.Errorf("JWT: generate key pair: %w", err)
	}
	if err := mgr.EnsureJWTIdentity(ctx); err != nil {
		return nil, fmt.Errorf("JWT: identity not reconciled with secret %s/%s: %w",
			IdentityNamespace, IdentitySecretName, err)
	}
	s.jwt = mgr
	log.Info("JWT: RSA key pair ready")

	s.setupRoutes()
	return s, nil
}

// setupRoutes configures HTTP routes.
// Router serves as the **unified API gateway**: all external traffic enters here.
// - Data-plane routes (invocations) are handled locally (session routing + reverse proxy to Pod).
// - Control-plane routes (code-interpreter CRUD, templates) are reverse-proxied to Workload Manager.
func (s *Server) setupRoutes() {
	s.engine = gin.New()
	s.engine.Use(gin.Recovery())
	s.engine.Use(metricsMiddleware())

	// Health check endpoints (no concurrency limit)
	s.engine.GET("/health/live", s.handleHealthLive)
	s.engine.GET("/health/ready", s.handleHealthReady)
	s.engine.GET("/health", s.handleHealthLive)
	s.engine.GET("/metrics", metricsHandler(s.refreshMetrics))

	// API v1 routes with concurrency limiting
	v1 := s.engine.Group("/v1")
	v1.Use(s.concurrencyLimitMiddleware())

	// SaFE API Key authentication middleware (Layer 1, default off)
	// When --enable-auth is set, all /v1/ requests must carry a valid SaFE API Key.
	if s.cfg.EnableAuth && s.safeClient != nil {
		// Strip caller-asserted identity only when SaFE can replace it with a
		// verified identity. In explicitly unauthenticated deployments, retain
		// the legacy upstream-provided identity headers.
		v1.Use(stripUntrustedIdentityHeaders())
		v1.Use(s.safeAuthMiddleware())
		log.Info("SaFE API Key auth middleware enabled on /v1/ routes")
	}

	// ── Data plane: invocation routes (handled locally) ──────────────────
	// CodeInterpreter invocations (support all standard HTTP methods)
	// GET: file download, directory listing, health check, session output, terminal screen
	// POST: execute commands, upload files, create sessions
	// DELETE: delete files, destroy sessions
	// PUT/PATCH: reserved for future use
	v1.GET("/namespaces/:namespace/code-interpreters/:name/invocations/*path", s.handleCodeInterpreterInvoke)
	v1.POST("/namespaces/:namespace/code-interpreters/:name/invocations/*path", s.handleCodeInterpreterInvoke)
	v1.DELETE("/namespaces/:namespace/code-interpreters/:name/invocations/*path", s.handleCodeInterpreterInvoke)
	v1.PUT("/namespaces/:namespace/code-interpreters/:name/invocations/*path", s.handleCodeInterpreterInvoke)
	v1.PATCH("/namespaces/:namespace/code-interpreters/:name/invocations/*path", s.handleCodeInterpreterInvoke)

	// ── Control plane: proxied to Workload Manager ───────────────────────
	// Sandbox session management
	v1.POST("/code-interpreter", s.proxyToWM)
	v1.POST("/code-interpreter/stream", s.proxyToWM) // SSE streaming sandbox creation
	v1.GET("/code-interpreter/sessions", s.proxyToWM)
	v1.GET("/code-interpreter/sessions/:sessionId", s.proxyToWM)
	v1.DELETE("/code-interpreter/sessions/:sessionId", s.proxyToWM)

	// Template management (CRUD)
	v1.POST("/templates", s.proxyToWM)
	v1.POST("/templates/stream", s.proxyToWM) // SSE streaming template creation
	v1.GET("/templates", s.proxyToWM)
	v1.GET("/templates/:namespace/:name", s.proxyToWM)
	v1.PUT("/templates/:namespace/:name", s.proxyToWM)
	v1.DELETE("/templates/:namespace/:name", s.proxyToWM)

	// Sandbox policy management (proxied to WM)
	v1.GET("/sandbox/sessions/:sessionId/policy", s.proxyToWM)
	v1.PATCH("/sandbox/sessions/:sessionId/policy", s.proxyToWM)
	v1.GET("/sandbox/sessions/:sessionId/logs", s.proxyToWM)

	// WM health (proxied for unified /v1/health)
	v1.GET("/health", s.proxyToWM)
}

// Run starts the HTTP server.
func (s *Server) Run(ctx context.Context) error {
	srv := &http.Server{
		Addr:    fmt.Sprintf(":%d", s.cfg.Port),
		Handler: s.engine,
	}
	errCh := make(chan error, 1)
	go func() {
		log.Info("router listening", "port", s.cfg.Port)
		errCh <- srv.ListenAndServe()
	}()
	select {
	case <-ctx.Done():
		return srv.Shutdown(context.Background())
	case err := <-errCh:
		return err
	}
}

// ─── Handlers ────────────────────────────────────────────────────────────────

func (s *Server) handleHealthLive(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"status": "alive"})
}

// wmHealthTimeout bounds the Workload Manager probe.
//
// It is shorter than the readiness probe's own timeoutSeconds=1 so the in-process
// request cannot outlive the probe that started it. The previous code called
// http.Get, which uses http.DefaultClient and has NO timeout: once the Workload
// Manager stopped answering, every 10s probe left a request hanging with no
// deadline, and the 72-minute outage on 2026-09-06 would have accumulated a few
// hundred of them.
const wmHealthTimeout = 900 * time.Millisecond

var wmHealthClient = &http.Client{Timeout: wmHealthTimeout}

// classifyProbeErr maps a transport error onto a small closed set.
//
// Never the raw error: it carries the dialled address, and as a metric label
// that mints a series per address.
func classifyProbeErr(err error) string {
	switch {
	case err == nil:
		return "status"
	case errors.Is(err, context.DeadlineExceeded), os.IsTimeout(err):
		return "timeout"
	case errors.Is(err, syscall.ECONNREFUSED):
		return "refused"
	case errors.Is(err, context.Canceled):
		return "canceled"
	default:
		return "error"
	}
}

// noteReadiness records the readiness result and logs only the edges.
//
// Logging every probe would add six lines a minute to a container log that
// already rotates within the hour, which is precisely how the 2026-09-06 window
// was lost. Logging only transitions would leave a single line that rotates away
// just as easily, so a sustained outage also gets a heartbeat -- enough to still
// be visible in a truncated log, few enough to read.
func (s *Server) noteReadiness(ready bool, check, reason, detail string) {
	if ready {
		routerReady.Set(1)
	} else {
		routerReady.Set(0)
		readinessFailures.WithLabelValues(check, reason).Inc()
	}

	s.readyMu.Lock()
	defer s.readyMu.Unlock()

	now := time.Now()
	if ready {
		if !s.wasReady && !s.notReadySince.IsZero() {
			log.Info("router.ready.recovered",
				"downSeconds", now.Sub(s.notReadySince).Seconds())
		}
		s.wasReady, s.notReadySince, s.lastUnreadyLog = true, time.Time{}, time.Time{}
		return
	}

	if s.wasReady || s.notReadySince.IsZero() {
		s.notReadySince, s.lastUnreadyLog = now, now
		s.wasReady = false
		log.Warn("router.ready.lost", "check", check, "reason", reason, "detail", detail)
		return
	}
	if now.Sub(s.lastUnreadyLog) >= unreadyHeartbeat {
		s.lastUnreadyLog = now
		log.Warn("router.ready.still_failing", "check", check, "reason", reason,
			"detail", detail, "downSeconds", now.Sub(s.notReadySince).Seconds())
	}
}

// unreadyHeartbeat is how often a sustained not-ready state repeats itself in
// the log. Five minutes turns a 72-minute outage into ~14 lines.
const unreadyHeartbeat = 5 * time.Minute

func (s *Server) handleHealthReady(c *gin.Context) {
	ctx := c.Request.Context()

	if err := s.store.Ping(ctx); err != nil {
		s.noteReadiness(false, "store", "error", err.Error())
		c.JSON(http.StatusServiceUnavailable, gin.H{"status": "not ready", "reason": "store: " + err.Error()})
		return
	}

	// Bound by the caller's context as well as the client timeout: when kubelet
	// gives up at timeoutSeconds it cancels the request, and this makes that
	// cancellation reach the outbound call instead of orphaning it.
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.cfg.WorkloadManagerURL+"/health", nil)
	if err != nil {
		s.noteReadiness(false, "workload_manager", "error", err.Error())
		c.JSON(http.StatusServiceUnavailable, gin.H{"status": "not ready", "reason": "workload-manager: " + err.Error()})
		return
	}
	resp, err := wmHealthClient.Do(req)
	if err != nil {
		s.noteReadiness(false, "workload_manager", classifyProbeErr(err), err.Error())
		c.JSON(http.StatusServiceUnavailable, gin.H{"status": "not ready", "reason": "workload-manager: " + err.Error()})
		return
	}
	// Drain and close on every path. The previous code closed the body only on
	// the 200 path, so a Workload Manager answering non-200 leaked a connection
	// per probe.
	defer func() {
		io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
		resp.Body.Close()
	}()
	if resp.StatusCode != http.StatusOK {
		detail := "status " + strconv.Itoa(resp.StatusCode)
		s.noteReadiness(false, "workload_manager", "status", detail)
		c.JSON(http.StatusServiceUnavailable, gin.H{"status": "not ready", "reason": "workload-manager: " + detail})
		return
	}

	s.noteReadiness(true, "", "", "")
	c.JSON(http.StatusOK, gin.H{"status": "ready"})
}

func (s *Server) refreshMetrics() {
	if s.store == nil {
		return
	}
	sandboxes, err := s.store.ListAllSandboxes(context.Background(), 100000)
	if err != nil {
		return
	}
	activeSessions.Set(float64(len(sandboxes)))
}

// handleCodeInterpreterInvoke handles CodeInterpreter invocation requests.
func (s *Server) handleCodeInterpreterInvoke(c *gin.Context) {
	s.handleInvoke(c, store.CodeInterpreterKind)
}

// handleInvoke is the shared invocation handler.
func (s *Server) handleInvoke(c *gin.Context, kind string) {
	namespace := c.Param("namespace")
	name := c.Param("name")
	path := c.Param("path") // Gin includes leading "/"

	// Extract session ID from request header
	sessionID := c.GetHeader("x-session-id")

	// Non-POST requests without x-session-id are rejected immediately.
	// Auto-creating a sandbox only makes sense for POST (execute, upload, create session).
	// GET/DELETE/PUT/PATCH are read or targeted operations that require an existing sandbox.
	if sessionID == "" && c.Request.Method != http.MethodPost {
		c.JSON(http.StatusBadRequest, gin.H{
			"error": "x-session-id header is required for " + c.Request.Method + " requests. " +
				"Create a sandbox first via POST /v1/code-interpreter to get a sessionId.",
		})
		return
	}

	if s.sessionManager == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "session manager not available"})
		return
	}

	// Get or create sandbox — delegate to SessionManager.
	// The SessionManager has a 3-layer lookup:
	//   1. Redis store (fast path)
	//   2. WM recovery endpoint → K8s Sandbox annotation (fallback when Redis data is lost)
	//   3. Error with actionable message
	// Auto-creation (when sessionID is empty) only happens for POST requests (guarded above).
	requestContext := withCallerCredentials(
		c.Request.Context(),
		c.GetHeader("Authorization"),
		c.GetHeader("Cookie"),
	)
	info, err := s.sessionManager.GetSandboxBySession(requestContext, sessionID, namespace, name, kind)
	if err != nil {
		log.Error("GetSandboxBySession failed",
			"kind", kind, "name", name, "sessionId", sessionID, "error", err)
		errMsg := err.Error()

		// Session not found (expired/deleted, not recoverable from K8s either)
		if strings.Contains(errMsg, "session") && strings.Contains(errMsg, "not found") {
			c.JSON(http.StatusNotFound, gin.H{"error": errMsg})
			return
		}
		// CodeInterpreter template not found in K8s
		if strings.Contains(errMsg, "not found") {
			c.JSON(http.StatusNotFound, gin.H{
				"error": fmt.Sprintf("%s %q not found in namespace %q", kind, name, namespace),
			})
			return
		}
		// Store connection error (Redis unreachable AND K8s recovery also failed)
		if strings.Contains(errMsg, "store lookup failed") {
			c.JSON(http.StatusServiceUnavailable, gin.H{
				"error":  "session store temporarily unavailable, please retry",
				"detail": errMsg,
			})
			return
		}
		c.JSON(http.StatusBadGateway, gin.H{"error": errMsg})
		return
	}
	sessionID = info.SessionID

	// A session ID is a routing handle, not an authorization credential.
	// When SaFE auth is enabled, only the owning user or a full system-admin may
	// invoke, proxy, or tunnel into the sandbox. A read-only admin is denied
	// because even GET/proxy/tunnel requests can trigger arbitrary user-service
	// side effects. Legacy mappings without an owner are recoverable only by a
	// full admin.
	if s.cfg.EnableAuth {
		callerID := c.GetString("userId")
		callerRole := c.GetString("userRole")
		if callerID == "" {
			recordCallerAuthRejection(c, http.StatusUnauthorized)
			c.JSON(http.StatusUnauthorized, gin.H{
				"error": "verified user identity is missing",
				"code":  "caller_identity_missing",
			})
			return
		}
		// Labelled like the 401s above: EnvD returns 403 too, for a session-id
		// binding it cannot match, and that one is an infrastructure fault
		// rather than an ownership decision made here.
		if callerRole != "system-admin" && (info.UserID == "" || info.UserID != callerID) {
			recordCallerAuthRejection(c, http.StatusForbidden)
			c.JSON(http.StatusForbidden, gin.H{
				"error": "sandbox access denied",
				"code":  "caller_not_session_owner",
			})
			return
		}
	}

	// Update last activity immediately, then keep refreshing while the proxy
	// connection is alive. This prevents GC from killing sandboxes that are
	// actively executing long-running commands (e.g. model training).
	refreshCtx, refreshCancel := context.WithCancel(context.Background())
	defer refreshCancel()
	go s.refreshActivityWhileAlive(refreshCtx, info.SessionID)

	// Inject session-id in response header
	c.Header("x-session-id", sessionID)

	// Port proxy: direct HTTP reverse-proxy to user service on sandbox pod
	if strings.HasPrefix(path, "/proxy/") {
		port, subPath, err := parsePortProxyPath(path)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		s.handlePortProxy(c, info, port, subPath)
		return
	}

	// WebSocket tunnel: bidirectional TCP forwarding via WebSocket
	if strings.HasPrefix(path, "/tunnel/") {
		port, err := parsePortTunnelPath(path)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
			return
		}
		s.handleTunnel(c, info, port)
		return
	}

	// Determine upstream URL via EntryPoints path-prefix matching
	if path == "" {
		path = "/"
	}
	targetURL := determineUpstreamURL(info, path)
	if c.Request.URL.RawQuery != "" {
		targetURL += "?" + c.Request.URL.RawQuery
	}

	if c.Request.Method == http.MethodPost && strings.HasPrefix(path, "/api/execute") {
		logRouterExecute(c, sessionID, namespace, name, path)
	}

	s.proxyRequest(c, targetURL, sessionID)
}

// logRouterExecute peeks the execute POST body, restores it, and logs every invocation.
func logRouterExecute(c *gin.Context, sessionID, namespace, workloadID, invokePath string) {
	if c.Request.Body == nil {
		return
	}
	body, err := io.ReadAll(c.Request.Body)
	if err != nil {
		return
	}
	c.Request.Body = io.NopCloser(bytes.NewReader(body))

	var payload struct {
		Command []string `json:"command"`
		Timeout string   `json:"timeout"`
	}
	if json.Unmarshal(body, &payload) != nil {
		return
	}
	log.Info("router.execute",
		"sessionId", sessionID,
		"namespace", namespace,
		"workloadId", workloadID,
		"path", invokePath,
		"timeout", payload.Timeout,
		"command", cmdlog.Preview(payload.Command, 0),
	)
}

// activityRefreshInterval controls how often LastActivity is updated while a
// proxy connection is open. Must be well below the default idle timeout (15min)
// to guarantee the sandbox is never mistakenly considered idle.
const activityRefreshInterval = 5 * time.Minute

// refreshActivityWhileAlive updates LastActivity immediately and then every
// activityRefreshInterval until ctx is cancelled (i.e. the proxy request ends).
// This keeps long-running requests (exec, stream, tunnel) from triggering idle GC.
func (s *Server) refreshActivityWhileAlive(ctx context.Context, sessionID string) {
	touch := func() {
		tCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		if err := s.store.UpdateSessionLastActivity(tCtx, sessionID, time.Now()); err != nil {
			// ErrNotFound here means the refresh had nowhere to land, so this
			// keepalive kept nothing alive -- the case the store contract now
			// reports rather than swallows. Not fatal: the request is still
			// being served, and idle-gc's recovery baseline covers the gap.
			// A cancelled ctx is just the request ending, so it is not a fault.
			if ctx.Err() != nil {
				return
			}
			log.Warn("router: session activity refresh did not land",
				"sessionId", sessionID, "error", err)
		}
	}

	touch()

	ticker := time.NewTicker(activityRefreshInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			touch()
		}
	}
}

// concurrencyLimitMiddleware limits concurrent requests.
func (s *Server) concurrencyLimitMiddleware() gin.HandlerFunc {
	cap := s.cfg.MaxConcurrentRequests
	if cap <= 0 {
		cap = 1 << 20
	}
	concurrency := make(chan struct{}, cap)
	return func(c *gin.Context) {
		select {
		case concurrency <- struct{}{}:
			defer func() { <-concurrency }()
			c.Next()
		default:
			c.JSON(http.StatusTooManyRequests, gin.H{"error": "server overloaded, please try again later"})
			c.Abort()
		}
	}
}

// determineUpstreamURL builds the upstream URL using EntryPoints path-prefix matching.
func determineUpstreamURL(info *store.SandboxInfo, path string) string {
	if len(info.EntryPoints) > 0 {
		// Find longest matching path prefix
		bestPrefix := ""
		bestEndpoint := ""
		for prefix, endpoint := range info.EntryPoints {
			if strings.HasPrefix(path, prefix) && len(prefix) > len(bestPrefix) {
				bestPrefix = prefix
				bestEndpoint = endpoint
			}
		}
		if bestEndpoint != "" {
			return fmt.Sprintf("http://%s%s", bestEndpoint, path)
		}
	}
	// Fallback: direct PodIP:PodPort
	port := info.PodPort
	if port == 0 {
		port = 8080
	}
	return fmt.Sprintf("http://%s:%d%s", info.PodIP, port, path)
}
