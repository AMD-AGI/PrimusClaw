// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Package workloadmanager implements the control-plane API for agent-sandbox.
// It handles sandbox creation/deletion, lifecycle management, and GC.
package workloadmanager

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/net/http2"
	"golang.org/x/net/http2/h2c"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"

	"sigs.k8s.io/agent-sandbox/pkg/api"
	"sigs.k8s.io/agent-sandbox/pkg/audit"
	"sigs.k8s.io/agent-sandbox/pkg/builder"
	"sigs.k8s.io/agent-sandbox/pkg/cmdlog"
	"sigs.k8s.io/agent-sandbox/pkg/grant"
	log "sigs.k8s.io/agent-sandbox/pkg/logx"
	"sigs.k8s.io/agent-sandbox/pkg/nsadmission"
	"sigs.k8s.io/agent-sandbox/pkg/policy"
	"sigs.k8s.io/agent-sandbox/pkg/safe"
	"sigs.k8s.io/agent-sandbox/pkg/store"
)

// AuditConfig holds audit logging configuration.
type AuditConfig struct {
	Enabled              bool
	RetentionDays        int
	ResourceFetchTimeout time.Duration
}

// Config holds Workload Manager configuration.
type Config struct {
	Port       int
	EnableAuth bool
	SafeAPIURL string
	Namespace  string
	GCInterval time.Duration
	DefaultTTL time.Duration
	Audit      AuditConfig
	// Namespaces decides which namespaces this Workload Manager serves: see
	// package nsadmission for the routes it covers. nil admits every namespace.
	Namespaces *nsadmission.Admitter
}

// DefaultConfig returns sensible defaults.
func DefaultConfig() Config {
	return Config{
		Port:       8080,
		Namespace:  "default",
		GCInterval: 15 * time.Second,
		DefaultTTL: 24 * time.Hour,
	}
}

// CreateSandboxRequest is the request body for POST /v1/code-interpreter.
// Resource configuration (CPU/mem/GPU) is defined in the CodeInterpreter template and cannot be overridden.
// Only safe parameters can be overridden via the "overrides" field.
type CreateSandboxRequest struct {
	Kind      string            `json:"kind,omitempty"`
	Name      string            `json:"name"`
	Namespace string            `json:"namespace,omitempty"`
	Overrides *SandboxOverrides `json:"overrides,omitempty"`
}

// SandboxOverrides contains parameters that users can override when creating a sandbox.
// These are "safe" overrides — they do NOT affect resource allocation or security boundaries.
type SandboxOverrides struct {
	// Environment variables to merge into the sandbox container (appended to template env).
	// Same-name vars override the template values.
	Environment map[string]string `json:"environment,omitempty"`
	// SessionTimeout overrides the idle timeout (no hard cap).
	// maxSessionDuration (24h) is the final backstop for sandbox lifetime.
	SessionTimeout string `json:"sessionTimeout,omitempty"`
	// MaxSessionDuration overrides the max lifetime. No cap: the value is applied
	// as given, and DefaultMaxSessionDuration (24h) is only the fallback when
	// neither this nor the template names one. (This used to claim a 24h cap that
	// silently reduced longer values. There is no such cap in the code, and a
	// comment promising one is how a caller decides not to ask for what it needs.)
	MaxSessionDuration string `json:"maxSessionDuration,omitempty"`
	// RuntimeClassName overrides the Pod runtime class (e.g. "kata-qemu" for VM isolation).
	// Only effective for non-WarmPool templates (WarmPool pods are pre-created with fixed runtime).
	// Set to pointer-to-empty-string to explicitly use default runc; nil means no override.
	RuntimeClassName *string `json:"runtimeClassName,omitempty"`
	// Labels to merge onto the Sandbox Pod (system prefixes are rejected).
	Labels map[string]string `json:"labels,omitempty"`
	// Annotations to merge onto the Sandbox Pod (system prefixes are rejected).
	Annotations map[string]string `json:"annotations,omitempty"`
}

// CreateSandboxResponse is the response body.
type CreateSandboxResponse struct {
	SessionID   string            `json:"sessionId"`
	SandboxName string            `json:"sandboxName"`
	Namespace   string            `json:"namespace"`
	EntryPoints map[string]string `json:"entryPoints,omitempty"`
}

// Server is the Workload Manager HTTP server.
type Server struct {
	cfg        Config
	store      store.Store
	k8s        *K8sSandboxCreator   // nil in dev mode; native API only
	workloads  *SafeWorkloadCreator // nil until the SaFE Workload client is attached
	router     *gin.Engine
	wg         sync.WaitGroup
	safeClient *safe.Client     // SaFE API Key verification client (nil when auth disabled)
	auditStore audit.AuditStore // nil when audit disabled
	builder    *builder.Builder // nil when image building not configured
}

// New creates a new Workload Manager server.
func New(cfg Config, st store.Store) *Server {
	s := &Server{cfg: cfg, store: st}

	// Initialize SaFE API Key client (when auth is enabled)
	if cfg.EnableAuth {
		if cfg.SafeAPIURL == "" {
			log.Error("WM: --enable-auth requires --safe-api-url to be set")
		} else {
			s.safeClient = safe.NewClient(cfg.SafeAPIURL)
			log.Info("WM: SaFE API Key authentication enabled", "safeAPIURL", cfg.SafeAPIURL)
		}
	}

	s.setupRoutes()
	return s
}

// WithK8s attaches a K8s sandbox creator (for production use).
func (s *Server) WithK8s(k8s *K8sSandboxCreator) *Server {
	s.k8s = k8s
	return s
}

// WithSafeWorkloads attaches the SaFE Workload writer used by the E2B control plane.
func (s *Server) WithSafeWorkloads(creator *SafeWorkloadCreator) *Server {
	s.workloads = creator
	return s
}

// WithAuditStore attaches an audit event store for lifecycle auditing.
func (s *Server) WithAuditStore(as audit.AuditStore) *Server {
	s.auditStore = as
	return s
}

// WithBuilder attaches an image builder for Dockerfile-based template creation.
func (s *Server) WithBuilder(b *builder.Builder) *Server {
	s.builder = b
	return s
}

// WithGrants serves the grant admin API. The caller token is checked inside
// the grant service, not by the SaFE middleware on /v1.
func (s *Server) WithGrants(svc *grant.Service) *Server {
	if svc == nil || s.router == nil {
		return s
	}
	grant.NewHandler(svc).Mount(s.router.Group("/internal/v1/grants"))
	return s
}

// Record stores a grant audit event and writes one process-log line.
func (s *Server) Record(ctx context.Context, event *audit.AuditEvent) {
	s.emitAudit(ctx, event)
	if event == nil {
		return
	}
	log.Info("grant audit", "event_type", event.EventType, "session_id", event.SessionID, "user_id", event.UserID)
}

// ReclaimSession deletes the sandbox for a session because its grant ended.
// An E2B Workload is deleted by its sandbox id first, including one that is
// still pending and has no session record. A missing session is already reclaimed.
func (s *Server) ReclaimSession(ctx context.Context, sessionID string) error {
	if sessionID == "" {
		return nil
	}
	deletedWorkload := false
	if s.workloads != nil && strings.HasPrefix(sessionID, e2bSandboxPrefix) {
		if err := s.workloads.Delete(ctx, sessionID); err != nil {
			return err
		}
		deletedWorkload = true
	}
	info, err := s.store.GetSandboxBySessionID(ctx, sessionID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) && deletedWorkload {
			s.recordReclaimedWorkload(ctx, &store.SandboxInfo{
				SessionID: sessionID, SandboxName: sessionID,
			})
			return nil
		}
		return err
	}
	if deletedWorkload && info.Kind == store.WorkloadKind {
		if err := s.store.DeleteSandboxBySessionID(ctx, sessionID); err != nil {
			return err
		}
		s.recordReclaimedWorkload(ctx, info)
		return nil
	}
	return s.deleteSandboxAndSession(ctx, info, audit.ReasonGrantReclaim)
}

// recordReclaimedWorkload records a Workload deleted by its stable sandbox id.
func (s *Server) recordReclaimedWorkload(ctx context.Context, info *store.SandboxInfo) {
	duration := int64(0)
	if !info.CreatedAt.IsZero() {
		duration = time.Since(info.CreatedAt).Milliseconds()
	}
	s.emitAudit(ctx, &audit.AuditEvent{
		ID: audit.NewEventID(), EventType: audit.EventDeleted,
		SessionID: info.SessionID, SandboxName: info.SandboxName, Namespace: info.Namespace,
		UserID: info.UserID, UserName: info.UserName,
		Timestamp: time.Now(), DeleteReason: audit.ReasonGrantReclaim,
		DurationMs: duration,
	})
	sandboxDeleteTotal.WithLabelValues(audit.ReasonGrantReclaim).Inc()
}

// emitAudit records an audit event (fire-and-forget, never blocks the caller).
// Production writes to the process log when Audit.Enabled; an optional
// auditStore is only for tests that assert on Store.
func (s *Server) emitAudit(ctx context.Context, event *audit.AuditEvent) {
	if !s.cfg.Audit.Enabled && s.auditStore == nil {
		return
	}
	audit.NormalizeEvent(event)
	if s.cfg.Audit.Enabled {
		audit.LogEvent(event)
	}
	if s.auditStore == nil {
		return
	}
	if err := s.auditStore.Store(ctx, event); err != nil {
		log.Warn("audit event store failed", "event_type", event.EventType,
			"session_id", event.SessionID, "error", err)
	}
}

// setupRoutes configures HTTP routes.
func (s *Server) setupRoutes() {
	s.router = gin.New()
	// The default recovery dumps request headers and masks only Authorization.
	s.router.Use(gin.RecoveryWithWriter(cmdlog.RedactingWriter(gin.DefaultErrorWriter)))

	// Health check (no auth required)
	s.router.GET("/health", s.handleHealthDeep)
	s.router.GET("/v1/health", s.handleHealthDeep)
	s.router.GET("/metrics", wmMetricsHandler(s.refreshMetrics))

	// API v1 routes
	v1 := s.router.Group("/v1")
	v1.Use(s.loggingMiddleware())

	// SaFE API Key authentication middleware (defense-in-depth)
	// When --enable-auth is set, WM also verifies API Keys on direct access.
	// For requests proxied from Router (with X-User-Id header), the existing header is trusted.
	if s.cfg.EnableAuth && s.safeClient != nil {
		v1.Use(s.safeAuthMiddleware())
		log.Info("WM: SaFE API Key auth middleware enabled on /v1/ routes")
	}

	// CodeInterpreter sandbox session endpoints (control plane).
	// Dual-read: a single path segment is a legacy opaque id (sess_*); two
	// segments are the canonical namespace/name. Gin requires the same wildcard
	// name at each depth, so the one-segment route reuses :namespace.
	v1.POST("/code-interpreter", s.handleCodeInterpreterCreate)
	v1.POST("/code-interpreter/stream", s.handleCodeInterpreterCreateStream)
	v1.GET("/code-interpreter/sessions", s.handleListSandboxes)
	v1.GET("/code-interpreter/sessions/:namespace/recover", s.handleRecoverSession)
	v1.GET("/code-interpreter/sessions/:namespace/:name/recover", s.handleRecoverSession)
	v1.GET("/code-interpreter/sessions/:namespace", s.handleGetSandbox)
	v1.DELETE("/code-interpreter/sessions/:namespace", s.handleDeleteSandbox)
	v1.GET("/code-interpreter/sessions/:namespace/:name", s.handleGetSandbox)
	v1.DELETE("/code-interpreter/sessions/:namespace/:name", s.handleDeleteSandbox)

	// Template management endpoints — CRUD for CodeInterpreter CRD objects.
	// Allows clients to manage templates without direct kubectl access.
	templates := v1.Group("/templates")
	templates.POST("", s.handleTemplateCreate)
	templates.POST("/stream", s.handleTemplateCreateStream)
	templates.GET("", s.handleTemplateList)
	templates.GET("/:namespace/:name", s.handleTemplateGet)
	templates.PUT("/:namespace/:name", s.handleTemplateUpdate)
	templates.DELETE("/:namespace/:name", s.handleTemplateDelete)

	// Sandbox policy management (§4.1 egress control) — stored on the SandboxPolicy CR.
	// Dual-read, same wildcard rule as sessions: the SDK percent-encodes the
	// session id into one path segment (sess_* or ns%2Fname).
	v1.GET("/sandbox/sessions/:namespace/policy", s.handleGetPolicy)
	v1.PATCH("/sandbox/sessions/:namespace/policy", s.handleUpdatePolicy)
	v1.GET("/sandbox/sessions/:namespace/logs", s.handleGetLogs)
	v1.GET("/sandbox/sessions/:namespace/:name/policy", s.handleGetPolicy)
	v1.PATCH("/sandbox/sessions/:namespace/:name/policy", s.handleUpdatePolicy)
	v1.GET("/sandbox/sessions/:namespace/:name/logs", s.handleGetLogs)

	// Internal APIs — called by EnvD within the cluster.
	// Uses a separate route group to bypass safeAuthMiddleware.
	// Authenticated via Router-signed JWT (same RSA key pair used for Router→EnvD auth).
	// Dual-read: EnvD embeds the session id from its annotation (sess_* or ns/name).
	internal := s.router.Group("/v1/internal", s.internalJWTMiddleware())
	internal.GET("/policy/:namespace", s.handleInternalPolicy)
	internal.POST("/audit/:namespace", s.handleInternalAudit)
	internal.GET("/policy/:namespace/:name", s.handleInternalPolicy)
	internal.POST("/audit/:namespace/:name", s.handleInternalAudit)
}

// Handler returns the HTTP handler serving every Workload Manager route.
func (s *Server) Handler() http.Handler {
	return s.router
}

// Run starts the HTTP server and the GC loop.
// Uses h2c (HTTP/2 cleartext) for efficient internal communication.
func (s *Server) Run(ctx context.Context) error {
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		s.runGC(ctx)
	}()

	// h2c wraps Gin handler with HTTP/2 cleartext support
	h2s := &http2.Server{}
	h2cHandler := h2c.NewHandler(s.Handler(), h2s)

	srv := &http.Server{
		Addr:        fmt.Sprintf(":%d", s.cfg.Port),
		Handler:     h2cHandler,
		ReadTimeout: 15 * time.Second,
		IdleTimeout: 90 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		log.Info("workload-manager listening", "port", s.cfg.Port)
		errCh <- srv.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		shutCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		return srv.Shutdown(shutCtx)
	case err := <-errCh:
		return err
	}
}

// ─── Middleware ───────────────────────────────────────────────────────────────

// loggingMiddleware logs each request.
func (s *Server) loggingMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		log.Info("request", "method", c.Request.Method, "path", c.Request.RequestURI,
			"clientIP", c.ClientIP(), "userAgent", c.Request.UserAgent(),
			"userId", c.GetHeader(UserIDHeader), "userName", c.GetHeader(UserNameHeader))
		c.Next()
		log.Info("response", "method", c.Request.Method, "path", c.Request.RequestURI,
			"status", c.Writer.Status(), "duration", time.Since(start))
	}
}

// ─── Handlers ────────────────────────────────────────────────────────────────

func (s *Server) handleHealthDeep(c *gin.Context) {
	ctx := c.Request.Context()
	checks := gin.H{}

	if err := s.store.Ping(ctx); err != nil {
		checks["store"] = err.Error()
		c.JSON(http.StatusServiceUnavailable, gin.H{"status": "degraded", "checks": checks})
		return
	}
	checks["store"] = "ok"

	if s.k8s != nil && s.k8s.kubeClient != nil {
		if _, err := s.k8s.kubeClient.CoreV1().Namespaces().List(ctx, metav1.ListOptions{Limit: 1}); err != nil {
			checks["kubernetes"] = "warning: " + err.Error()
		} else {
			checks["kubernetes"] = "ok"
		}
	} else {
		checks["kubernetes"] = "skipped"
	}

	c.JSON(http.StatusOK, gin.H{"status": "ok", "checks": checks})
}

// admitNamespace applies namespace admission to a request in namespace: a
// namespace outside the selector gets 403 namespace_not_admitted (see package
// nsadmission for why not 404). It returns true when the request may proceed.
func (s *Server) admitNamespace(c *gin.Context, namespace string) bool {
	return s.cfg.Namespaces.Gate(c, namespace)
}

// admitSession applies namespace admission to a request keyed by session ID,
// judged by the namespace the session's sandbox lives in. It returns true when
// the request may proceed.
func (s *Server) admitSession(c *gin.Context, info *store.SandboxInfo) bool {
	return s.cfg.Namespaces.Gate(c, info.Namespace)
}

// handleCodeInterpreterCreate handles POST /v1/code-interpreter.
func (s *Server) handleCodeInterpreterCreate(c *gin.Context) {
	s.handleCreate(c, store.CodeInterpreterKind)
}

// handleCodeInterpreterCreateStream handles POST /v1/code-interpreter/stream.
// Creates a sandbox and streams creation progress via SSE (Server-Sent Events).
// Progress is not currently incremental: this delegates to the synchronous path
// and emits the result as a single SSE event. Streaming real progress would mean
// splitting CreateSandbox into separate create and watch steps.
func (s *Server) handleCodeInterpreterCreateStream(c *gin.Context) {
	createStatus := "failed"
	createTemplate := ""
	defer func() {
		if createTemplate != "" {
			sandboxCreateTotal.WithLabelValues(createTemplate, createStatus).Inc()
		}
	}()

	// Parse request body FIRST, before starting SSE response.
	// Once SSE headers are flushed the server may close the request body reader
	// (especially under h2c + ReadTimeout), causing "invalid Read on closed Body".
	var req CreateSandboxRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request: " + err.Error()})
		return
	}
	if req.Name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name is required"})
		return
	}
	createTemplate = req.Name
	if req.Namespace == "" {
		req.Namespace = s.cfg.Namespace
	}
	// Before the SSE headers: once they are flushed a 403 can no longer be sent.
	if !s.admitNamespace(c, req.Namespace) {
		return
	}

	// Setup SSE headers (after body is fully consumed)
	c.Writer.Header().Set("Content-Type", "text/event-stream")
	c.Writer.Header().Set("Cache-Control", "no-cache")
	c.Writer.Header().Set("Connection", "keep-alive")
	c.Writer.Header().Set("X-Accel-Buffering", "no")
	c.Writer.Flush()

	flusher, ok := c.Writer.(http.Flusher)
	if !ok {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "streaming not supported"})
		return
	}
	writeSSE := func(event string, data interface{}) {
		b, _ := json.Marshal(data)
		fmt.Fprintf(c.Writer, "event: %s\ndata: %s\n\n", event, string(b))
		flusher.Flush()
	}

	writeSSE("phase", BuildPhase{Phase: "creating", Status: "started", Message: "Creating sandbox..."})

	ns := req.Namespace

	var user *UserIdentity
	if userID := c.GetHeader(UserIDHeader); userID != "" {
		user = &UserIdentity{UserID: userID, UserName: c.GetHeader(UserNameHeader)}
	}

	if s.k8s != nil {
		result, createErr := s.k8s.CreateSandbox(c.Request.Context(), req.Name, ns, user, req.Overrides)
		if createErr != nil {
			writeSSE("phase", BuildPhase{Phase: "creating", Status: "failed", Message: createErr.Error()})
			writeSSE("end", gin.H{"build_status": "failed", "error": createErr.Error()})
			return
		}

		sessionID := result.SessionID
		// MaxSessionDuration is normalized in CreateSandbox (override > template > 24h default).
		ttl := s.cfg.DefaultTTL
		if result.MaxSessionDuration > 0 {
			ttl = result.MaxSessionDuration
		}
		info := &store.SandboxInfo{
			Kind: result.Kind, SessionID: sessionID, SandboxName: result.SandboxName,
			Namespace: ns, PodIP: result.PodIP, PodPort: 8080,
			CreatedAt: time.Now(), LastActivity: time.Now(),
			ExpiresAt: time.Now().Add(ttl), Status: "running",
			EntryPoints: map[string]string{"/": fmt.Sprintf("%s:%d", result.PodIP, 8080)},
		}
		if user != nil {
			info.UserID = user.UserID
			info.UserName = user.UserName
		}
		if err := s.store.StoreSandbox(c.Request.Context(), info); err != nil {
			writeSSE("error", gin.H{"error": "failed to store session: " + err.Error()})
			return
		}

		s.emitAudit(c.Request.Context(), &audit.AuditEvent{
			ID: audit.NewEventID(), EventType: audit.EventCreated,
			SessionID: sessionID, SandboxName: result.SandboxName, Namespace: ns,
			UserID: info.UserID, UserName: info.UserName,
			Timestamp: time.Now(), TemplateName: req.Name,
		})
		s.emitAudit(c.Request.Context(), &audit.AuditEvent{
			ID: audit.NewEventID(), EventType: audit.EventReady,
			SessionID: sessionID, SandboxName: result.SandboxName, Namespace: ns,
			Timestamp: time.Now(), TimeToReadyMs: time.Since(info.CreatedAt).Milliseconds(),
		})

		writeSSE("phase", BuildPhase{Phase: "ready", Status: "completed", Message: "Sandbox ready"})
		writeSSE("end", gin.H{
			"build_status": "ready",
			"sessionId":    sessionID,
			"sandboxName":  result.SandboxName,
			"namespace":    ns,
		})
		createStatus = "success"
	} else {
		sessionID := api.FormatSandboxID(ns, req.Name)
		info := &store.SandboxInfo{
			SessionID: sessionID, SandboxName: req.Name, Namespace: ns,
			PodIP: "127.0.0.1", PodPort: 8080,
			CreatedAt: time.Now(), LastActivity: time.Now(),
			ExpiresAt: time.Now().Add(s.cfg.DefaultTTL), Status: "running",
			EntryPoints: map[string]string{"/": "127.0.0.1:8080"},
		}
		if user != nil {
			info.UserID = user.UserID
			info.UserName = user.UserName
		}
		if err := s.store.StoreSandbox(c.Request.Context(), info); err != nil {
			writeSSE("error", gin.H{"error": "failed to store session: " + err.Error()})
			return
		}
		writeSSE("phase", BuildPhase{Phase: "ready", Status: "completed", Message: "Dev mode"})
		writeSSE("end", gin.H{
			"build_status": "ready",
			"sessionId":    sessionID,
			"sandboxName":  req.Name,
			"namespace":    ns,
		})
		createStatus = "success"
	}
}

// handleCreate is the shared sandbox creation logic.
func (s *Server) handleCreate(c *gin.Context, kind string) {
	var req CreateSandboxRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request body: " + err.Error()})
		return
	}
	createStatus := "failed"
	defer func() {
		if req.Name != "" {
			sandboxCreateTotal.WithLabelValues(req.Name, createStatus).Inc()
		}
	}()

	// Validate request
	if req.Name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name is required"})
		return
	}
	if req.Namespace == "" {
		req.Namespace = s.cfg.Namespace
	}
	if req.Namespace == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "namespace is required"})
		return
	}
	if !s.admitNamespace(c, req.Namespace) {
		return
	}

	ns := req.Namespace

	var podIP, sandboxName, sessionID string
	var result *SandboxResult
	sandboxKind := store.SandboxKind
	ttl := s.cfg.DefaultTTL // overridden by MaxSessionDuration (override > template > 24h default)

	// Extract user identity from auth middleware (nil when auth disabled)
	var user *UserIdentity
	if userID := c.GetHeader(UserIDHeader); userID != "" {
		user = &UserIdentity{
			UserID:   userID,
			UserName: c.GetHeader(UserNameHeader),
		}
	}

	if s.k8s != nil {
		// Permission check: verify user can use this template (own / public / admin)
		if uid := currentUserID(c); uid != "" {
			ci, tmplErr := s.k8s.GetTemplate(c.Request.Context(), req.Name, ns)
			if tmplErr != nil {
				c.JSON(http.StatusNotFound, gin.H{"error": fmt.Sprintf("template %q not found in namespace %q", req.Name, ns)})
				return
			}
			if !isTemplateReadable(c, ci) {
				c.JSON(http.StatusForbidden, gin.H{"error": "you don't have permission to use this template"})
				return
			}
		}

		var createErr error
		result, createErr = s.k8s.CreateSandbox(c.Request.Context(), req.Name, ns, user, req.Overrides)
		if createErr != nil {
			log.Error("failed to create sandbox", "kind", kind, "name", req.Name, "error", createErr)
			if errors.Is(createErr, ErrTemplateNotFound) {
				c.JSON(http.StatusNotFound, gin.H{
					"error": fmt.Sprintf("%s %q not found in namespace %q", kind, req.Name, ns),
				})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": createErr.Error()})
			return
		}
		podIP = result.PodIP
		sandboxName = result.SandboxName
		sessionID = result.SessionID
		sandboxKind = result.Kind
		// Per-resource maxSessionDuration overrides global TTL (no hard cap).
		// sessionTimeout is stored as a K8s Sandbox annotation for metadata;
		// Brain owns idle reclaim, not a control-plane idle-GC controller.
		if result.MaxSessionDuration > 0 {
			ttl = result.MaxSessionDuration
		}
	} else {
		podIP = "127.0.0.1"
		sandboxName = req.Name
		sessionID = api.FormatSandboxID(ns, sandboxName)
	}

	// Update placeholder with real sandbox info.
	// sessionTimeout lives on the Sandbox annotation as metadata.
	// Idle reclaim is Brain's jobs probe, not a control-plane idle-GC.
	info := &store.SandboxInfo{
		Kind:         sandboxKind,
		SessionID:    sessionID,
		SandboxName:  sandboxName,
		Namespace:    ns,
		PodIP:        podIP,
		PodPort:      8080,
		CreatedAt:    time.Now(),
		LastActivity: time.Now(),
		ExpiresAt:    time.Now().Add(ttl),
		Status:       "running",
		EntryPoints:  map[string]string{"/": fmt.Sprintf("%s:%d", podIP, 8080)},
	}
	if user != nil {
		info.UserID = user.UserID
		info.UserName = user.UserName
	}
	if err := s.store.StoreSandbox(c.Request.Context(), info); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to store session: " + err.Error()})
		return
	}

	// Audit: sandbox.created + sandbox.ready
	s.emitAudit(c.Request.Context(), &audit.AuditEvent{
		ID: audit.NewEventID(), EventType: audit.EventCreated,
		SessionID: sessionID, SandboxName: sandboxName, Namespace: ns,
		UserID: info.UserID, UserName: info.UserName,
		Timestamp: time.Now(), TemplateName: req.Name,
	})
	s.emitAudit(c.Request.Context(), &audit.AuditEvent{
		ID: audit.NewEventID(), EventType: audit.EventReady,
		SessionID: sessionID, SandboxName: sandboxName, Namespace: ns,
		Timestamp: time.Now(), TimeToReadyMs: time.Since(info.CreatedAt).Milliseconds(),
	})

	c.JSON(http.StatusOK, CreateSandboxResponse{
		SessionID:   sessionID,
		SandboxName: sandboxName,
		Namespace:   ns,
		EntryPoints: map[string]string{
			"default": fmt.Sprintf("http://%s:%d", podIP, 8080),
		},
	})
	createStatus = "success"
}

// ─── Sandbox list & detail handlers ──────────────────────────────────────────

// ListSandboxesRequest defines query parameters for listing sandboxes.
// Follows SaFE ListWorkloadRequest convention: offset/limit pagination, sortBy/order, multi-field filters.
type ListSandboxesRequest struct {
	// Filter by user ID (exact match)
	UserID string `form:"userId" binding:"omitempty"`
	// Filter by username (fuzzy match, same as SaFE)
	UserName string `form:"userName" binding:"omitempty"`
	// Filter by namespace (exact match)
	Namespace string `form:"namespace" binding:"omitempty"`
	// Filter by status: creating, running (exact match)
	Status string `form:"status" binding:"omitempty"`
	// Filter by session ID (fuzzy match)
	SessionID string `form:"sessionId" binding:"omitempty"`
	// Filter by sandbox name (fuzzy match)
	SandboxName string `form:"sandboxName" binding:"omitempty"`
	// Pagination offset, default 0
	Offset int `form:"offset" binding:"omitempty,min=0"`
	// Pagination limit, default 100
	Limit int `form:"limit" binding:"omitempty,min=1"`
	// Sort field: createdAt, lastActivity, expiresAt. Default: createdAt
	SortBy string `form:"sortBy" binding:"omitempty"`
	// Sort order: desc, asc. Default: desc
	Order string `form:"order" binding:"omitempty,oneof=desc asc"`
}

// SandboxListItem is a single item in the sandbox list response (frontend-friendly).
type SandboxListItem struct {
	SessionID    string            `json:"sessionId"`
	SandboxName  string            `json:"sandboxName"`
	Namespace    string            `json:"namespace"`
	Status       string            `json:"status"`
	PodIP        string            `json:"podIp,omitempty"`
	EntryPoints  map[string]string `json:"entryPoints,omitempty"`
	CreatedAt    time.Time         `json:"createdAt"`
	LastActivity time.Time         `json:"lastActivity"`
	ExpiresAt    time.Time         `json:"expiresAt"`
	UserID       string            `json:"userId,omitempty"`
	UserName     string            `json:"userName,omitempty"`
}

// SandboxListResponse is the response body for GET /v1/code-interpreter/sessions.
// totalCount is the total BEFORE pagination (same as SaFE convention).
type SandboxListResponse struct {
	TotalCount int               `json:"totalCount"`
	Items      []SandboxListItem `json:"items"`
}

// handleListSandboxes handles GET /v1/code-interpreter/sessions.
// Supports filtering by userId, namespace, status, sessionId, sandboxName.
// Supports pagination (offset/limit) and sorting (sortBy/order).
func (s *Server) handleListSandboxes(c *gin.Context) {
	var req ListSandboxesRequest
	if err := c.ShouldBindQuery(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid query parameters: " + err.Error()})
		return
	}
	// Defaults
	if req.Limit <= 0 {
		req.Limit = 100
	}
	if req.SortBy == "" {
		req.SortBy = "createdAt"
	}
	if req.Order == "" {
		req.Order = "desc"
	}

	// Permission: default users can only see their own sandboxes
	if !canViewAll(c) {
		if uid := currentUserID(c); uid != "" {
			req.UserID = uid // force filter to own sandboxes
		}
	}

	if !s.cfg.Namespaces.GateReady(c) {
		return
	}
	all, err := s.store.ListAllSandboxes(c.Request.Context(), 10000)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to list sandboxes: " + err.Error()})
		return
	}

	// ── Filter ──
	filtered := make([]SandboxListItem, 0, len(all))
	for _, info := range all {
		// Skip placeholders
		if info.Status == "creating" {
			continue
		}
		if req.UserID != "" && info.UserID != req.UserID {
			continue
		}
		if req.UserName != "" && !strings.Contains(strings.ToLower(info.UserName), strings.ToLower(req.UserName)) {
			continue
		}
		if req.Namespace != "" && info.Namespace != req.Namespace {
			continue
		}
		// Sessions in namespaces this deployment does not serve are not listed.
		if !s.cfg.Namespaces.Filter(info.Namespace) {
			continue
		}
		if req.Status != "" && info.Status != req.Status {
			continue
		}
		if req.SessionID != "" && !strings.Contains(info.SessionID, req.SessionID) {
			continue
		}
		if req.SandboxName != "" && !strings.Contains(info.SandboxName, req.SandboxName) {
			continue
		}
		filtered = append(filtered, SandboxListItem{
			SessionID:    info.SessionID,
			SandboxName:  info.SandboxName,
			Namespace:    info.Namespace,
			Status:       info.Status,
			PodIP:        info.PodIP,
			EntryPoints:  info.EntryPoints,
			CreatedAt:    info.CreatedAt,
			LastActivity: info.LastActivity,
			ExpiresAt:    info.ExpiresAt,
			UserID:       info.UserID,
			UserName:     info.UserName,
		})
	}

	// ── Sort ──
	sort.Slice(filtered, func(i, j int) bool {
		var ti, tj time.Time
		switch req.SortBy {
		case "lastActivity":
			ti, tj = filtered[i].LastActivity, filtered[j].LastActivity
		case "expiresAt":
			ti, tj = filtered[i].ExpiresAt, filtered[j].ExpiresAt
		default: // createdAt
			ti, tj = filtered[i].CreatedAt, filtered[j].CreatedAt
		}
		if req.Order == "asc" {
			return ti.Before(tj)
		}
		return ti.After(tj) // desc
	})

	// ── Paginate ──
	totalCount := len(filtered)
	start := req.Offset
	if start > totalCount {
		start = totalCount
	}
	end := start + req.Limit
	if end > totalCount {
		end = totalCount
	}

	c.JSON(http.StatusOK, SandboxListResponse{
		TotalCount: totalCount,
		Items:      filtered[start:end],
	})
}

func pathSandboxRef(c *gin.Context) (namespace, name, id string, ok bool) {
	namespace = c.Param("namespace")
	name = c.Param("name")
	if namespace == "" || name == "" {
		return "", "", "", false
	}
	return namespace, name, api.FormatSandboxID(namespace, name), true
}

// pathSessionID returns the session id from route params.
// One segment (:namespace only) is a legacy opaque id; two segments are
// canonical namespace/name.
func pathSessionID(c *gin.Context) (string, bool) {
	ns := strings.TrimSpace(c.Param("namespace"))
	name := strings.TrimSpace(c.Param("name"))
	if ns == "" {
		return "", false
	}
	if name == "" {
		return ns, true
	}
	return api.FormatSandboxID(ns, name), true
}

// resolvePathSandbox returns namespace/name for handlers that need object
// identity. Canonical routes supply them directly; legacy one-segment routes
// resolve via the session store / Sandbox CR annotation index.
func (s *Server) resolvePathSandbox(c *gin.Context) (namespace, name, sessionID string, ok bool) {
	if ns, n, id, ok := pathSandboxRef(c); ok {
		return ns, n, id, true
	}
	sessionID, ok = pathSessionID(c)
	if !ok {
		return "", "", "", false
	}
	if ns, n, parsed := api.ParseSandboxID(sessionID); parsed {
		return ns, n, sessionID, true
	}
	ctx := c.Request.Context()
	if s.store != nil {
		info, err := s.store.GetSandboxBySessionID(ctx, sessionID)
		if err == nil {
			return info.Namespace, info.SandboxName, sessionID, true
		}
		if !errors.Is(err, store.ErrNotFound) {
			return "", "", "", false
		}
	}
	if s.k8s != nil {
		info, err := s.k8s.RecoverSessionFromK8s(ctx, sessionID)
		if err == nil {
			return info.Namespace, info.SandboxName, sessionID, true
		}
	}
	return "", "", "", false
}

// handleGetSandbox handles GET /v1/code-interpreter/sessions/:sessionId and
// /sessions/:namespace/:name.
// Returns detail info for a single sandbox session.
// Permission: default users can only get their own sandboxes.
//
// LastActivity is returned as stored metadata for listing/sort; this GET does
// not refresh it. Sandbox lifetime is owned by Brain jobs reclaim.
func (s *Server) handleGetSandbox(c *gin.Context) {
	sessionID, ok := pathSessionID(c)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "session id is required"})
		return
	}

	info, err := s.store.GetSandboxBySessionID(c.Request.Context(), sessionID)
	restoreRecovered := false
	if err != nil {
		// Only a confirmed missing record justifies a rebuild. An unreadable
		// store is a different fact: the real record may still be there.
		// Policy lives on the SandboxPolicy CR and is loaded with recovery.
		// This endpoint is polled every 60s per session, so a brief store blip
		// must not rebuild fleet-wide from a partial view.
		if !errors.Is(err, store.ErrNotFound) {
			log.Warn("session store unreadable; not rebuilding from the CR",
				"sessionId", sessionID, "error", err)
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "session store unavailable"})
			return
		}
		// CRStore already resolves from the Sandbox CR; a second recover is the
		// same lookup and only adds API Server load.
		if _, ok := s.store.(*CRStore); ok {
			c.JSON(http.StatusNotFound, gin.H{"error": "session not found: " + err.Error()})
			return
		}
		// Rebuild from the Sandbox CR — the same source the Router recovery path uses.
		recovered, recoverErr := s.recoverSessionRecord(c.Request.Context(), sessionID)
		if recoverErr != nil {
			log.Warn("session lookup and recovery both failed",
				"sessionId", sessionID, "lookupError", err, "recoverError", recoverErr)
			c.JSON(http.StatusNotFound, gin.H{"error": "session not found: " + err.Error()})
			return
		}
		info, restoreRecovered = recovered, true
	}
	if !s.admitSession(c, info) {
		return
	}

	// Permission check: non-admin users can only see their own sandboxes
	if !canViewAll(c) {
		if uid := currentUserID(c); uid != "" && info.UserID != uid {
			c.JSON(http.StatusForbidden, gin.H{"error": "you can only view your own sandboxes"})
			return
		}
	}

	// Persist the rebuild only once the caller is allowed to see this session,
	// matching handleRecoverSession. Storing before the check would let anyone
	// who knows a session id trigger a write against someone else's record and
	// only then be refused.
	if restoreRecovered {
		s.restoreRecoveredSession(c.Request.Context(), info)
	}

	c.JSON(http.StatusOK, SandboxListItem{
		SessionID:    info.SessionID,
		SandboxName:  info.SandboxName,
		Namespace:    info.Namespace,
		Status:       info.Status,
		PodIP:        info.PodIP,
		EntryPoints:  info.EntryPoints,
		CreatedAt:    info.CreatedAt,
		LastActivity: info.LastActivity,
		ExpiresAt:    info.ExpiresAt,
		UserID:       info.UserID,
		UserName:     info.UserName,
	})
}

// recoverSessionRecord rebuilds a session mapping from the Sandbox CR.
//
// The Sandbox CR is the source of truth for routing. This only reads: persisting
// the result is left to the caller, which has to authorise the request before it
// writes anything.
func (s *Server) recoverSessionRecord(ctx context.Context, sessionID string) (*store.SandboxInfo, error) {
	if s.k8s == nil {
		return nil, errors.New("k8s sandbox creator unavailable")
	}
	return s.k8s.RecoverSessionFromK8s(ctx, sessionID)
}

// restoreRecoveredSession puts a rebuilt record back in the store, best effort.
//
// Best effort on purpose: the caller has already been answered from the recovered
// record, and failing the request because the store is the broken part would deny
// a session that is demonstrably alive.
func (s *Server) restoreRecoveredSession(ctx context.Context, info *store.SandboxInfo) {
	if err := s.store.StoreSandbox(ctx, info); err != nil {
		log.Warn("recovered a session but could not re-store it",
			"sessionId", info.SessionID, "sandbox", info.SandboxName, "error", err)
		return
	}
	log.Info("rebuilt a lost session record from the Sandbox annotations",
		"sessionId", info.SessionID, "sandbox", info.SandboxName)
}

// handleRecoverSession handles GET .../sessions/:sessionId/recover and
// .../sessions/:namespace/:name/recover.
// The Router calls this to resolve a session from the Sandbox CR when the local
// store path cannot answer.
//
// Flow:
//  1. Resolve the Sandbox CR by namespace/name (or session-id annotation)
//  2. If found, reconstruct SandboxInfo (CRStore writes are no-ops)
//  3. Return the recovered SandboxInfo to the Router
func (s *Server) handleRecoverSession(c *gin.Context) {
	sessionID, ok := pathSessionID(c)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "session id is required"})
		return
	}

	// Quick check: is the session already resolvable from the store?
	if info, err := s.store.GetSandboxBySessionID(c.Request.Context(), sessionID); err == nil {
		if !canMutateSandbox(c, info.UserID) {
			c.JSON(http.StatusForbidden, gin.H{"error": "session recovery denied"})
			return
		}
		c.JSON(http.StatusOK, gin.H{
			"sessionId":   info.SessionID,
			"userId":      info.UserID,
			"userName":    info.UserName,
			"sandboxName": info.SandboxName,
			"namespace":   info.Namespace,
			"podIp":       info.PodIP,
			"podPort":     info.PodPort,
			"entryPoints": info.EntryPoints,
			"status":      info.Status,
			"source":      "store",
		})
		return
	}

	if s.k8s == nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found and K8s not available"})
		return
	}

	// Recover from K8s: find Sandbox with matching session-id annotation.
	info, err := s.k8s.RecoverSessionFromK8s(c.Request.Context(), sessionID)
	if err != nil {
		log.Warn("session recovery failed", "sessionId", sessionID, "error", err)
		c.JSON(http.StatusNotFound, gin.H{"error": "session not found in store or K8s: " + err.Error()})
		return
	}
	if !canMutateSandbox(c, info.UserID) {
		c.JSON(http.StatusForbidden, gin.H{"error": "session recovery denied"})
		return
	}

	if storeErr := s.store.StoreSandbox(c.Request.Context(), info); storeErr != nil {
		log.Warn("failed to re-store recovered session", "sessionId", sessionID, "error", storeErr)
	} else {
		log.Info("session recovered from K8s", "sessionId", sessionID, "sandbox", info.SandboxName)
	}

	c.JSON(http.StatusOK, gin.H{
		"sessionId":   info.SessionID,
		"userId":      info.UserID,
		"userName":    info.UserName,
		"sandboxName": info.SandboxName,
		"namespace":   info.Namespace,
		"podIp":       info.PodIP,
		"podPort":     info.PodPort,
		"entryPoints": info.EntryPoints,
		"status":      info.Status,
		"source":      "k8s",
	})
}

// handleDeleteSandbox handles DELETE .../sessions/:sessionId and
// .../sessions/:namespace/:name.
// Permission: default/readonly users can only delete their own sandboxes; system-admin can delete any.
func (s *Server) handleDeleteSandbox(c *gin.Context) {
	sessionID, ok := pathSessionID(c)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "session id is required"})
		return
	}

	info, err := s.store.GetSandboxBySessionID(c.Request.Context(), sessionID)
	if err != nil {
		if errors.Is(err, store.ErrNotFound) {
			c.JSON(http.StatusNotFound, gin.H{"error": "session not found: " + err.Error()})
			return
		}
		log.Warn("delete session lookup failed", "sessionId", sessionID, "error", err)
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "failed to query session"})
		return
	}
	if !s.admitSession(c, info) {
		return
	}

	// Permission check: non-admin users can only delete their own sandboxes
	if !canWriteAll(c) {
		if uid := currentUserID(c); uid != "" && info.UserID != uid {
			c.JSON(http.StatusForbidden, gin.H{"error": "you can only delete your own sandboxes"})
			return
		}
	}

	if err := s.deleteSandboxAndSession(c.Request.Context(), info, audit.ReasonUserDelete); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to delete sandbox: " + err.Error()})
		return
	}
	c.Status(http.StatusNoContent)
}

// ─── GC ──────────────────────────────────────────────────────────────────────

func (s *Server) runGC(ctx context.Context) {
	ticker := time.NewTicker(s.cfg.GCInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.gcOnce(ctx)
		}
	}
}

func (s *Server) gcOnce(ctx context.Context) {
	gcCycleTotal.Inc()
	now := time.Now()

	// Delete every session past its hard ExpiresAt. A fixed first-page limit
	// would let persistent failures starve later records indefinitely.
	if expired, err := s.store.ListExpiredSandboxes(ctx, now, 0); err == nil {
		for _, info := range expired {
			log.Info("GC: deleting expired sandbox", "session", info.SessionID, "sandbox", info.SandboxName)
			if err := s.deleteSandboxAndSession(ctx, info, audit.ReasonGCTTL); err != nil {
				log.Warn("GC: sandbox delete failed", "session", info.SessionID, "sandbox", info.SandboxName, "error", err)
			}
		}
	}

	// Audit retention cleanup
	if s.auditStore != nil {
		cutoff := now.AddDate(0, 0, -s.cfg.Audit.RetentionDays)
		if deleted, err := s.auditStore.DeleteBefore(ctx, cutoff); err != nil {
			log.Warn("GC: audit cleanup failed", "error", err)
		} else if deleted > 0 {
			log.Info("GC: cleaned up old audit events", "deleted", deleted)
		}
	}
}

// deleteSandboxAndSession deletes the workload and then the session record.
// A failed workload delete keeps the session so the caller can retry.
func (s *Server) deleteSandboxAndSession(ctx context.Context, info *store.SandboxInfo, reason string) error {
	switch {
	case info.Kind == store.WorkloadKind:
		if s.workloads == nil {
			return fmt.Errorf("safe workload client is not configured")
		}
		if err := s.workloads.Delete(ctx, info.SandboxName); err != nil {
			log.Warn("failed to delete workload", "workload", info.SandboxName, "error", err)
			return err
		}
	case s.k8s != nil:
		var err error
		if info.Kind == store.SandboxClaimKind {
			err = s.k8s.DeleteSandboxClaim(ctx, info)
		} else {
			err = s.k8s.DeleteSandbox(ctx, info)
		}
		if err != nil {
			log.Warn("failed to delete K8s resource",
				"kind", info.Kind, "sandbox", info.SandboxName, "error", err)
			return err
		}
	}
	s.emitAudit(ctx, &audit.AuditEvent{
		ID: audit.NewEventID(), EventType: audit.EventDeleted,
		SessionID: info.SessionID, SandboxName: info.SandboxName, Namespace: info.Namespace,
		UserID: info.UserID, UserName: info.UserName,
		Timestamp: time.Now(), DeleteReason: reason,
		DurationMs: time.Since(info.CreatedAt).Milliseconds(),
	})
	sandboxDeleteTotal.WithLabelValues(reason).Inc()
	return s.store.DeleteSandboxBySessionID(ctx, info.SessionID)
}

// ─── Template management handlers ────────────────────────────────────────────

// handleTemplateCreate handles POST /v1/templates.
// Creates a new CodeInterpreter CRD in Kubernetes, stamps creator identity on annotations.
//
// When warmPoolSize > 0, automatically waits for the first WarmPool Pod to be Ready or Failed,
// then returns the CodeInterpreter object enriched with build_log and build_duration.
// When warmPoolSize == 0, returns immediately (no Pod to validate).
func (s *Server) handleTemplateCreate(c *gin.Context) {
	if s.k8s == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "K8s not available in dev mode"})
		return
	}
	var req CreateTemplateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request: " + err.Error()})
		return
	}
	if req.Namespace == "" {
		req.Namespace = "default"
	}
	// Before the image build: a denied namespace must not cost a kaniko run.
	if !s.admitNamespace(c, req.Namespace) {
		return
	}

	// Extract user identity from auth middleware
	var user *UserIdentity
	if userID := c.GetHeader(UserIDHeader); userID != "" {
		user = &UserIdentity{
			UserID:   userID,
			UserName: c.GetHeader(UserNameHeader),
		}
	}

	// Permission: only system-admin can create public templates
	public := req.Public
	if public && !canWriteAll(c) {
		public = false // silently downgrade
		log.Warn("non-admin tried to create public template, downgraded to private",
			"userId", currentUserID(c), "template", req.Name)
	}

	// If Dockerfile is provided, build image via kaniko and update fromImage.
	if req.Dockerfile != "" && s.builder != nil {
		log.Info("building custom image from Dockerfile", "template", req.Name)
		buildResult, buildErr := s.builder.Build(c.Request.Context(), req.Name, req.Dockerfile)
		if buildErr != nil {
			c.JSON(http.StatusUnprocessableEntity, gin.H{
				"error": "image build failed: " + buildErr.Error(),
			})
			return
		}
		log.Info("image built", "template", req.Name, "image", buildResult.Image,
			"cached", buildResult.Cached, "duration", buildResult.Duration)
		req.Spec.Template.FromImage = buildResult.Image
	}

	ci, err := s.k8s.CreateTemplate(c.Request.Context(), req.Name, req.Namespace, req.Spec, user, public)
	if err != nil {
		errMsg := err.Error()
		if strings.Contains(errMsg, "already exists") {
			c.JSON(http.StatusConflict, gin.H{"error": errMsg})
		} else {
			c.JSON(http.StatusInternalServerError, gin.H{"error": errMsg})
		}
		return
	}
	s.refreshMetrics()

	// If warmPoolSize > 0, wait for the first WarmPool Pod to validate the template.
	// This ensures the user gets immediate feedback about build failures (bad image,
	// failing run steps, etc.) instead of discovering them later when creating a sandbox.
	warmPoolSize := int32(0)
	if req.Spec.WarmPoolSize != nil {
		warmPoolSize = *req.Spec.WarmPoolSize
	}

	if warmPoolSize > 0 {
		log.Info("Template has warmPoolSize > 0, waiting for first WarmPool Pod",
			"template", req.Name, "warmPoolSize", warmPoolSize)

		buildResult, buildErr := s.k8s.WatchTemplateBuild(
			c.Request.Context(), req.Namespace, req.Name, 3*time.Minute,
		)
		if buildResult != nil {
			// Return CI object enriched with build info
			resp := gin.H{
				"metadata":       ci.ObjectMeta,
				"spec":           ci.Spec,
				"status":         ci.Status,
				"build_status":   buildResult.BuildStatus,
				"build_duration": buildResult.BuildDuration,
				"build_log":      buildResult.BuildLog,
			}
			if buildErr != nil {
				// Build failed — return 422 with build_log for diagnostics
				resp["error"] = buildErr.Error()
				c.JSON(http.StatusUnprocessableEntity, resp)
				return
			}
			c.JSON(http.StatusCreated, resp)
			return
		}
		// buildResult is nil — something went wrong with the watch itself
		if buildErr != nil {
			log.Warn("Template build watch failed, returning template without build_log",
				"template", req.Name, "error", buildErr)
		}
	}

	c.JSON(http.StatusCreated, ci)
}

// handleTemplateCreateStream handles POST /v1/templates/stream.
// Creates a template and streams build progress via SSE (Server-Sent Events).
// When warmPoolSize > 0, streams real-time WarmPool Pod startup phases and container logs.
// When warmPoolSize == 0, streams CRD creation confirmation and ends immediately.
func (s *Server) handleTemplateCreateStream(c *gin.Context) {
	if s.k8s == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "K8s not available in dev mode"})
		return
	}
	var req CreateTemplateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request: " + err.Error()})
		return
	}
	if req.Namespace == "" {
		req.Namespace = "default"
	}
	if !s.admitNamespace(c, req.Namespace) {
		return
	}

	var user *UserIdentity
	if userID := c.GetHeader(UserIDHeader); userID != "" {
		user = &UserIdentity{
			UserID:   userID,
			UserName: c.GetHeader(UserNameHeader),
		}
	}

	// Setup SSE headers
	c.Writer.Header().Set("Content-Type", "text/event-stream")
	c.Writer.Header().Set("Cache-Control", "no-cache")
	c.Writer.Header().Set("Connection", "keep-alive")
	c.Writer.Header().Set("X-Accel-Buffering", "no")
	c.Writer.Flush()

	flusher, ok := c.Writer.(http.Flusher)
	if !ok {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "streaming not supported"})
		return
	}

	// Helper to write SSE events
	writeSSE := func(event string, data interface{}) {
		b, _ := json.Marshal(data)
		fmt.Fprintf(c.Writer, "event: %s\ndata: %s\n\n", event, string(b))
		flusher.Flush()
	}

	// Permission: only system-admin can create public templates
	public := req.Public
	if public && !canWriteAll(c) {
		public = false
		log.Warn("non-admin tried to create public template (stream), downgraded to private",
			"userId", currentUserID(c), "template", req.Name)
	}

	// Create the template CRD
	writeSSE("phase", BuildPhase{Phase: "crd_creation", Status: "started"})
	ci, err := s.k8s.CreateTemplate(c.Request.Context(), req.Name, req.Namespace, req.Spec, user, public)
	if err != nil {
		errMsg := err.Error()
		writeSSE("phase", BuildPhase{Phase: "crd_creation", Status: "failed", Message: errMsg})
		writeSSE("end", map[string]interface{}{"build_status": "failed", "error": errMsg})
		return
	}
	writeSSE("phase", BuildPhase{Phase: "crd_creation", Status: "completed", Message: fmt.Sprintf("CodeInterpreter %s/%s created", req.Namespace, req.Name)})

	// If warmPoolSize > 0, stream the WarmPool Pod build process
	warmPoolSize := int32(0)
	if req.Spec.WarmPoolSize != nil {
		warmPoolSize = *req.Spec.WarmPoolSize
	}

	if warmPoolSize > 0 {
		eventCh := make(chan BuildEvent, 100)
		go s.k8s.WatchTemplateBuildSSE(c.Request.Context(), req.Namespace, req.Name, 3*time.Minute, eventCh)

		for event := range eventCh {
			writeSSE(event.EventType, event.Data)
		}
	} else {
		writeSSE("end", map[string]interface{}{
			"build_status": "ready",
			"message":      "Template created (no WarmPool configured)",
		})
	}

	_ = ci // ci already used above; avoid unused warning
}

// ListTemplatesRequest defines query parameters for listing templates.
type ListTemplatesRequest struct {
	// Filter by namespace (exact match). Empty = all namespaces.
	Namespace string `form:"namespace" binding:"omitempty"`
	// Filter by creator user ID (exact match on label)
	UserID string `form:"userId" binding:"omitempty"`
	// Filter by creator username (fuzzy match on annotation)
	UserName string `form:"userName" binding:"omitempty"`
	// Filter by template name (fuzzy match)
	Name string `form:"name" binding:"omitempty"`
	// Filter by public status: "true" = only public, "false" = only private, empty = all (subject to role)
	Public string `form:"public" binding:"omitempty,oneof=true false"`
	// Pagination offset, default 0
	Offset int `form:"offset" binding:"omitempty,min=0"`
	// Pagination limit, default 100
	Limit int `form:"limit" binding:"omitempty,min=1"`
	// Sort field: name, createdAt. Default: createdAt
	SortBy string `form:"sortBy" binding:"omitempty"`
	// Sort order: desc, asc. Default: desc
	Order string `form:"order" binding:"omitempty,oneof=desc asc"`
}

// TemplateListResponse is the paginated template list response (SaFE convention).
type TemplateListResponse struct {
	TotalCount int                               `json:"totalCount"`
	Items      []runtimev1alpha1.CodeInterpreter `json:"items"`
}

// handleTemplateList handles GET /v1/templates.
// Supports filtering by namespace, userId, name, public; pagination (offset/limit); sorting (sortBy/order).
// Permission: default users see only own + public templates; admin roles see all.
func (s *Server) handleTemplateList(c *gin.Context) {
	if s.k8s == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "K8s not available in dev mode"})
		return
	}

	var req ListTemplatesRequest
	if err := c.ShouldBindQuery(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid query parameters: " + err.Error()})
		return
	}
	if req.Limit <= 0 {
		req.Limit = 100
	}
	if req.SortBy == "" {
		req.SortBy = "createdAt"
	}
	if req.Order == "" {
		req.Order = "desc"
	}

	// For permission-based filtering, we fetch ALL templates and filter in Go.
	// K8s Label Selectors don't support OR (user.id=X OR public=true),
	// so server-side (Go) filtering is the simplest correct approach.
	// Template count is typically small (<1000), so this is efficient enough.
	if !s.cfg.Namespaces.GateReady(c) {
		return
	}
	result, err := s.k8s.ListTemplates(c.Request.Context(), req.Namespace, "")
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}

	viewAll := canViewAll(c)
	uid := currentUserID(c)

	// ── Filter ──
	filtered := make([]runtimev1alpha1.CodeInterpreter, 0, len(result.Items))
	for _, ci := range result.Items {
		// Templates in namespaces this deployment does not serve are not listed.
		if !s.cfg.Namespaces.Filter(ci.Namespace) {
			continue
		}
		// Permission filter: default users see only own + public templates
		if !viewAll && uid != "" {
			isOwner := ci.Labels != nil && ci.Labels[userIDLabelKey] == uid
			isPublic := ci.Labels != nil && ci.Labels[templatePublicLabelKey] == "true"
			if !isOwner && !isPublic {
				continue
			}
		}

		// Explicit public filter from query parameter
		if req.Public == "true" && (ci.Labels == nil || ci.Labels[templatePublicLabelKey] != "true") {
			continue
		}
		if req.Public == "false" && ci.Labels != nil && ci.Labels[templatePublicLabelKey] == "true" {
			continue
		}

		// userId filter (explicit query parameter, works for admin users querying specific user's templates)
		if req.UserID != "" && (ci.Labels == nil || ci.Labels[userIDLabelKey] != req.UserID) {
			continue
		}

		// userName filter (fuzzy match on annotation)
		if req.UserName != "" && !strings.Contains(strings.ToLower(ci.Annotations[userNameAnnotationKey]), strings.ToLower(req.UserName)) {
			continue
		}
		// Name filter (fuzzy match)
		if req.Name != "" && !strings.Contains(ci.Name, req.Name) {
			continue
		}
		filtered = append(filtered, ci)
	}

	// ── Sort ──
	sort.Slice(filtered, func(i, j int) bool {
		switch req.SortBy {
		case "name":
			if req.Order == "asc" {
				return filtered[i].Name < filtered[j].Name
			}
			return filtered[i].Name > filtered[j].Name
		default: // createdAt
			ti := filtered[i].CreationTimestamp.Time
			tj := filtered[j].CreationTimestamp.Time
			if req.Order == "asc" {
				return ti.Before(tj)
			}
			return ti.After(tj)
		}
	})

	// ── Paginate ──
	totalCount := len(filtered)
	start := req.Offset
	if start > totalCount {
		start = totalCount
	}
	end := start + req.Limit
	if end > totalCount {
		end = totalCount
	}

	c.JSON(http.StatusOK, TemplateListResponse{
		TotalCount: totalCount,
		Items:      filtered[start:end],
	})
}

// handleTemplateGet handles GET /v1/templates/:namespace/:name.
// Permission: default users can only get own or public templates.
func (s *Server) handleTemplateGet(c *gin.Context) {
	if s.k8s == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "K8s not available in dev mode"})
		return
	}
	name := c.Param("name")
	namespace := c.Param("namespace")
	if !s.admitNamespace(c, namespace) {
		return
	}
	ci, err := s.k8s.GetTemplate(c.Request.Context(), name, namespace)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}

	// Permission check: must be readable (admin / owner / public)
	if !isTemplateReadable(c, ci) {
		c.JSON(http.StatusForbidden, gin.H{"error": "you don't have permission to access this template"})
		return
	}

	c.JSON(http.StatusOK, ci)
}

// handleTemplateUpdate handles PUT /v1/templates/:namespace/:name.
// Permission: only owner or system-admin can update; only system-admin can change public status.
func (s *Server) handleTemplateUpdate(c *gin.Context) {
	if s.k8s == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "K8s not available in dev mode"})
		return
	}
	name := c.Param("name")
	namespace := c.Param("namespace")
	if !s.admitNamespace(c, namespace) {
		return
	}
	var req UpdateTemplateRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request: " + err.Error()})
		return
	}

	// Fetch existing template for permission check
	existing, err := s.k8s.GetTemplate(c.Request.Context(), name, namespace)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}

	// Permission check: must be writable (system-admin or owner)
	if !isTemplateWritable(c, existing) {
		c.JSON(http.StatusForbidden, gin.H{"error": "only the template owner or system-admin can update this template"})
		return
	}

	// Public change: only system-admin can modify
	if req.Public != nil && !canWriteAll(c) {
		c.JSON(http.StatusForbidden, gin.H{"error": "only system-admin can change template public status"})
		return
	}

	ci, err := s.k8s.UpdateTemplate(c.Request.Context(), name, namespace, req.Spec, req.Public)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, ci)
}

// handleTemplateDelete handles DELETE /v1/templates/:namespace/:name.
// Permission: only owner or system-admin can delete.
func (s *Server) handleTemplateDelete(c *gin.Context) {
	if s.k8s == nil {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "K8s not available in dev mode"})
		return
	}
	name := c.Param("name")
	namespace := c.Param("namespace")
	if !s.admitNamespace(c, namespace) {
		return
	}

	// Fetch existing template for permission check
	existing, err := s.k8s.GetTemplate(c.Request.Context(), name, namespace)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}

	// Permission check: must be writable (system-admin or owner)
	if !isTemplateWritable(c, existing) {
		c.JSON(http.StatusForbidden, gin.H{"error": "only the template owner or system-admin can delete this template"})
		return
	}

	if err := s.k8s.DeleteTemplate(c.Request.Context(), name, namespace); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	s.refreshMetrics()
	c.Status(http.StatusNoContent)
}

// ─── Internal API handlers (EnvD ↔ WM) ──────────────────────────────────────

// internalJWTMiddleware validates Router-signed JWTs on internal API requests.
// EnvD captures the JWT from Router's forwarded request and reuses it when calling
// the WM internal policy API. The JWT is verified using the same RSA public key
// that WM already caches for Pod injection (from the envd-router-identity Secret).
func (s *Server) internalJWTMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		auth := c.GetHeader("Authorization")
		const prefix = "Bearer "
		if !strings.HasPrefix(auth, prefix) {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "missing Authorization header"})
			c.Abort()
			return
		}
		tokenStr := auth[len(prefix):]

		rsaPub := GetCachedRSAPublicKey()
		if rsaPub == nil {
			log.Warn("internalJWTMiddleware: Router public key not yet cached")
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Router public key not available yet"})
			c.Abort()
			return
		}

		token, err := jwt.Parse(tokenStr, func(t *jwt.Token) (interface{}, error) {
			if _, ok := t.Method.(*jwt.SigningMethodRSA); !ok {
				return nil, fmt.Errorf("unexpected signing method: %v", t.Header["alg"])
			}
			return rsaPub, nil
		}, jwt.WithExpirationRequired(), jwt.WithIssuedAt(), jwt.WithLeeway(time.Minute))

		if err != nil || !token.Valid {
			log.Warn("internalJWTMiddleware: JWT validation failed", "error", err)
			c.JSON(http.StatusUnauthorized, gin.H{"error": "invalid or expired JWT"})
			c.Abort()
			return
		}

		// Bind JWT session_id claim to the requested path session id
		// (legacy :sessionId or canonical :namespace/:name).
		// Prevents IDOR: a JWT for session A cannot be used to read session B's policy.
		claims, ok := token.Claims.(jwt.MapClaims)
		if !ok {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "unexpected JWT claims type"})
			c.Abort()
			return
		}
		jwtSessionID, _ := claims["session_id"].(string)
		reqSessionID, ok := pathSessionID(c)
		if ok && jwtSessionID != reqSessionID {
			c.JSON(http.StatusForbidden, gin.H{"error": "JWT session_id does not match requested sandbox"})
			c.Abort()
			return
		}

		c.Next()
	}
}

// handleInternalPolicy serves GET /v1/internal/policy/{sessionId} and
// /policy/{namespace}/{name}. EnvD polls this for SandboxPolicy CR updates.
func (s *Server) handleInternalPolicy(c *gin.Context) {
	namespace, name, sessionID, ok := s.resolvePathSandbox(c)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "sandbox not found"})
		return
	}

	pol := defaultSandboxPolicy()
	if s.k8s != nil {
		if _, err := s.k8s.GetSandbox(c.Request.Context(), namespace, name); err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "sandbox not found"})
			return
		}
		loaded, found, err := s.k8s.GetSandboxPolicy(c.Request.Context(), namespace, name)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to query policy"})
			return
		}
		if !found {
			c.JSON(http.StatusNotFound, gin.H{"error": "sandbox policy not found"})
			return
		}
		pol = loaded
	} else if s.store != nil {
		// Dev/test without a K8s client: serve the policy mirrored in the store.
		info, err := s.store.GetSandboxBySessionID(c.Request.Context(), sessionID)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			log.Warn("handleInternalPolicy: store error", "sessionId", sessionID, "error", err)
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to query session"})
			return
		}
		pol = policyFromInfo(info)
	}

	type policyResponse struct {
		PolicyVersion        int64    `json:"policyVersion"`
		RuntimePolicy        string   `json:"runtimePolicy,omitempty"`
		PolicyMode           string   `json:"policyMode,omitempty"`
		AllowedEgressHosts   []string `json:"allowedEgressHosts,omitempty"`
		AllowedInternalHosts []string `json:"allowedInternalHosts,omitempty"`
	}

	resp := policyResponse{
		PolicyVersion:        pol.PolicyVersion,
		RuntimePolicy:        pol.RuntimePolicy,
		PolicyMode:           pol.PolicyMode,
		AllowedEgressHosts:   pol.AllowedEgressHosts,
		AllowedInternalHosts: pol.AllowedInternalHosts,
	}
	if resp.PolicyVersion == 0 {
		resp.PolicyVersion = 1
	}

	c.JSON(http.StatusOK, resp)
}

// ─── Policy management handlers (§4.1) ──────────────────────────────────────

// handleGetPolicy handles GET /v1/sandbox/sessions/:namespace/policy and
// /sessions/:namespace/:name/policy.
func (s *Server) handleGetPolicy(c *gin.Context) {
	namespace, name, sessionID, ok := s.resolvePathSandbox(c)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "sandbox not found"})
		return
	}

	var pol sandboxPolicy
	var ownerUserID string
	if s.k8s != nil {
		sb, err := s.k8s.GetSandbox(c.Request.Context(), namespace, name)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "sandbox not found"})
			return
		}
		if !s.admitNamespace(c, namespace) {
			return
		}
		if sb.Labels != nil {
			ownerUserID = sb.Labels[userIDLabelKey]
		}
		loaded, found, err := s.k8s.GetSandboxPolicy(c.Request.Context(), namespace, name)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to query policy"})
			return
		}
		if !found {
			c.JSON(http.StatusNotFound, gin.H{"error": "sandbox policy not found"})
			return
		}
		pol = loaded
	} else if s.store != nil {
		info, err := s.store.GetSandboxBySessionID(c.Request.Context(), sessionID)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				c.JSON(http.StatusNotFound, gin.H{"error": "sandbox not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to query session"})
			return
		}
		if !s.admitNamespace(c, namespace) {
			return
		}
		ownerUserID = info.UserID
		pol = policyFromInfo(info)
	} else {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "K8s not available in dev mode"})
		return
	}

	if !canViewAll(c) && !canMutateSandbox(c, ownerUserID) {
		c.JSON(http.StatusForbidden, gin.H{"error": "you can only view your own sandbox policy"})
		return
	}

	c.JSON(http.StatusOK, gin.H{
		"sessionId":            sessionID,
		"runtimePolicy":        pol.RuntimePolicy,
		"policyMode":           pol.PolicyMode,
		"allowedEgressHosts":   pol.AllowedEgressHosts,
		"allowedInternalHosts": pol.AllowedInternalHosts,
		"policyVersion":        pol.PolicyVersion,
	})
}

// UpdatePolicyRequest is the request body for PATCH /v1/sandbox/sessions/:namespace/policy
// and /sessions/:namespace/:name/policy.
type UpdatePolicyRequest struct {
	AllowedEgressHosts   *[]string `json:"allowedEgressHosts,omitempty"`
	AllowedInternalHosts *[]string `json:"allowedInternalHosts,omitempty"`
	PolicyMode           *string   `json:"policyMode,omitempty"`
}

// handleUpdatePolicy handles PATCH /v1/sandbox/sessions/:namespace/policy and
// /sessions/:namespace/:name/policy.
func (s *Server) handleUpdatePolicy(c *gin.Context) {
	namespace, name, sessionID, ok := s.resolvePathSandbox(c)
	if !ok {
		c.JSON(http.StatusNotFound, gin.H{"error": "sandbox not found"})
		return
	}

	var req UpdatePolicyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid request: " + err.Error()})
		return
	}
	if req.AllowedInternalHosts != nil {
		for _, cidr := range *req.AllowedInternalHosts {
			if err := policy.ValidateInternalCIDR(cidr); err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
				return
			}
		}
	}
	if req.PolicyMode != nil && *req.PolicyMode != "enforce" && *req.PolicyMode != "audit" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "policyMode must be 'enforce' or 'audit'"})
		return
	}

	applyReq := func(pol *sandboxPolicy) error {
		if req.AllowedInternalHosts != nil {
			pol.AllowedInternalHosts = *req.AllowedInternalHosts
		}
		if req.AllowedEgressHosts != nil {
			pol.AllowedEgressHosts = *req.AllowedEgressHosts
		}
		if req.PolicyMode != nil {
			pol.PolicyMode = *req.PolicyMode
		}
		return nil
	}

	var pol sandboxPolicy
	if s.k8s != nil {
		sb, err := s.k8s.GetSandbox(c.Request.Context(), namespace, name)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "sandbox not found"})
			return
		}
		if !s.admitNamespace(c, namespace) {
			return
		}
		ownerUserID := ""
		if sb.Labels != nil {
			ownerUserID = sb.Labels[userIDLabelKey]
		}
		if !canMutateSandbox(c, ownerUserID) {
			c.JSON(http.StatusForbidden, gin.H{"error": "you can only update your own sandbox policy"})
			return
		}
		pol, err = s.k8s.PatchSandboxPolicy(c.Request.Context(), namespace, name, applyReq)
		if err != nil {
			if apierrors.IsNotFound(err) {
				c.JSON(http.StatusNotFound, gin.H{"error": "sandbox policy not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update policy: " + err.Error()})
			return
		}
	} else if s.store != nil {
		info, err := s.store.GetSandboxBySessionID(c.Request.Context(), sessionID)
		if err != nil {
			if errors.Is(err, store.ErrNotFound) {
				c.JSON(http.StatusNotFound, gin.H{"error": "sandbox not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to query session"})
			return
		}
		if !s.admitNamespace(c, namespace) {
			return
		}
		if !canMutateSandbox(c, info.UserID) {
			c.JSON(http.StatusForbidden, gin.H{"error": "you can only update your own sandbox policy"})
			return
		}
		pol = policyFromInfo(info)
		_ = applyReq(&pol)
		pol.PolicyVersion++
		info.RuntimePolicy = pol.RuntimePolicy
		info.PolicyMode = pol.PolicyMode
		info.AllowedEgressHosts = pol.AllowedEgressHosts
		info.AllowedInternalHosts = pol.AllowedInternalHosts
		info.PolicyVersion = pol.PolicyVersion
		if err := s.store.StoreSandbox(c.Request.Context(), info); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "failed to update policy: " + err.Error()})
			return
		}
	} else {
		c.JSON(http.StatusServiceUnavailable, gin.H{"error": "K8s not available in dev mode"})
		return
	}

	policyUpdateTotal.WithLabelValues(sessionID).Inc()
	log.Info("policy updated", "sessionId", sessionID, "version", pol.PolicyVersion)

	c.JSON(http.StatusOK, gin.H{
		"sessionId":            sessionID,
		"runtimePolicy":        pol.RuntimePolicy,
		"policyMode":           pol.PolicyMode,
		"allowedEgressHosts":   pol.AllowedEgressHosts,
		"allowedInternalHosts": pol.AllowedInternalHosts,
		"policyVersion":        pol.PolicyVersion,
	})
}

func (s *Server) refreshMetrics() {
	if s.store != nil {
		sandboxes, err := s.store.ListAllSandboxes(context.Background(), 100000)
		if err == nil {
			sandboxActiveGauge.Set(float64(len(sandboxes)))
		}
	}
	if s.k8s != nil {
		templates, err := s.k8s.ListTemplates(context.Background(), "", "")
		if err == nil {
			templateTotal.Set(float64(len(templates.Items)))
		}
	}
}
