// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package envd

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"sigs.k8s.io/agent-sandbox/pkg/envd/egress"
	log "sigs.k8s.io/agent-sandbox/pkg/logx"
	"sigs.k8s.io/agent-sandbox/pkg/policy"
)

// How long a shutdown may spend draining in-flight requests before the
// remaining connections are closed outright. envd is PID 1, so if it does not
// return the container does not stop: an unbounded drain leaves the pod
// Running with its listeners already closed, which reads from outside as a
// crash with no exit code and no log. Kept well under the pod's 30s
// termination grace so the exit is envd's own rather than a SIGKILL — any
// override must respect that bound too.
const defaultShutdownDrainTimeout = 10 * time.Second

// Slack on top of the drain budget, after which shutdown is abandoned and the
// process exits anyway. The drain has a deadline of its own; the steps around it
// do not, and they are the ones that can block on something this process does
// not hold -- CleanupIPTables shells out to iptables, which waits on the xtables
// lock whatever else on the node happens to be holding. Ignoring their errors
// does not help, because hanging is not an error. Together with the drain this
// still lands well inside the pod's 30s termination grace, so the exit remains
// envd's own rather than a SIGKILL.
//
// A var rather than a const only so tests can widen it. The timer ends the
// process when it fires, so a test binary that loses a scheduling race to it
// takes the whole package down with it, and none of the shutdown tests are about
// this bound. Nothing in production reassigns it.
var shutdownHardExitGrace = 2 * time.Second

// Server is the EnvD HTTP server.
type Server struct {
	workspace     string
	port          int
	auth          *authManager       // Phase 3: JWT auth manager (nil publicKey = auth disabled)
	inference     *inferenceKeyCache // §4.2: caches inference API Key from WM (one-time fetch)
	tmuxWidth     int
	tmuxHeight    int
	egressProxy   *egress.TransparentProxy // §4.1: transparent proxy for outbound traffic control
	egressEnabled bool
	policyEngine  *policy.Engine // §4.1: egress policy engine (nil when egress disabled)
	policySyncer  *PolicySyncer  // §4.1: periodic policy pull from WM
	auditReporter *egressAuditReporter
	drainTimeout  time.Duration
}

// Config holds EnvD configuration.
type Config struct {
	Port            int
	Workspace       string
	TMuxWidth       int
	TMuxHeight      int
	EgressEnabled   bool     // §4.1: enable transparent proxy + SSRF protection
	ExtraBlockCIDRs []string // §4.1: additional CIDRs to block (e.g. 169.254.0.0/16)
	// Shutdown drain budget; zero takes defaultShutdownDrainTimeout. Must stay
	// under the pod's termination grace, or the drain ends in a SIGKILL.
	ShutdownDrainTimeout time.Duration
}

// DefaultConfig returns sensible defaults.
func DefaultConfig() Config {
	return Config{
		Port:       8080,
		Workspace:  "/home/sandbox",
		TMuxWidth:  200,
		TMuxHeight: 50,
	}
}

// New creates a new EnvD server.
func New(cfg Config) (*Server, error) {
	if cfg.TMuxWidth == 0 {
		cfg.TMuxWidth = 200
	}
	if cfg.TMuxHeight == 0 {
		cfg.TMuxHeight = 50
	}
	if cfg.ShutdownDrainTimeout <= 0 {
		cfg.ShutdownDrainTimeout = defaultShutdownDrainTimeout
	}

	am := newAuthManager()
	if err := am.loadFromEnv(); err != nil {
		return nil, fmt.Errorf("loading public key: %w", err)
	}

	s := &Server{
		workspace:     cfg.Workspace,
		port:          cfg.Port,
		auth:          am,
		inference:     newInferenceKeyCache(),
		tmuxWidth:     cfg.TMuxWidth,
		tmuxHeight:    cfg.TMuxHeight,
		egressEnabled: cfg.EgressEnabled,
		drainTimeout:  cfg.ShutdownDrainTimeout,
	}

	if cfg.EgressEnabled {
		// Initialize policy engine with default config (will be updated by PolicySyncer)
		policyEngine := policy.New(&policy.PolicyConfig{
			RuntimePolicy: "agent-default",
			Mode:          "enforce",
			Version:       0,
		})
		s.policyEngine = policyEngine

		proxyCfg := egress.DefaultProxyConfig()
		proxyCfg.ExtraBlockCIDRs = cfg.ExtraBlockCIDRs
		proxy, err := egress.NewTransparentProxy(proxyCfg, egress.NewPolicyEngineAdapter(policyEngine))
		if err != nil {
			return nil, fmt.Errorf("init egress proxy: %w", err)
		}
		reporter := newEgressAuditReporter(s.inference)
		s.auditReporter = reporter
		s.egressProxy = proxy.WithEventReporter(reporter)
	}

	return s, nil
}

// Handler returns the HTTP handler for EnvD.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// Health check (unauthenticated)
	mux.HandleFunc("/health", s.handleHealth)

	// Command execution
	mux.HandleFunc("/api/execute", s.handleExecute)
	mux.HandleFunc("/api/execute/stream", s.handleExecuteStream)

	// Session (tmux)
	mux.HandleFunc("/api/session/create", s.handleSessionCreate)
	mux.HandleFunc("/api/session/", func(w http.ResponseWriter, r *http.Request) {
		// /api/session/{id}/exec
		// /api/session/{id}/output
		// DELETE /api/session/{id}
		path := strings.TrimPrefix(r.URL.Path, "/api/session/")
		parts := strings.SplitN(path, "/", 2)
		if len(parts) < 1 || parts[0] == "" {
			httpError(w, "missing session id", http.StatusBadRequest)
			return
		}
		sessionID := parts[0]
		if len(parts) == 1 {
			// DELETE /api/session/{id}
			s.handleSessionDelete(w, r, sessionID)
			return
		}
		switch parts[1] {
		case "exec":
			s.handleSessionExec(w, r, sessionID)
		case "output":
			s.handleSessionOutput(w, r, sessionID)
		default:
			httpError(w, "unknown session endpoint: "+parts[1], http.StatusNotFound)
		}
	})

	// Terminal (interactive)
	mux.HandleFunc("/api/terminal/", func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/api/terminal/")
		parts := strings.SplitN(path, "/", 2)
		if len(parts) < 2 {
			httpError(w, "missing terminal id or action", http.StatusBadRequest)
			return
		}
		sessionID := parts[0]
		switch parts[1] {
		case "send_keys":
			s.handleTerminalSendKeys(w, r, sessionID)
		case "screen":
			s.handleTerminalScreen(w, r, sessionID)
		default:
			httpError(w, "unknown terminal endpoint: "+parts[1], http.StatusNotFound)
		}
	})

	// Files
	mux.HandleFunc("/api/files", s.handleFiles)
	mux.HandleFunc("/api/files/", s.handleFiles)

	// GPU
	mux.HandleFunc("/api/gpu/status", s.handleGPUStatus)

	// Middleware chain (outer runs first): JWT auth → session capture → handler
	return s.jwtMiddleware(s.sessionCaptureMiddleware(mux))
}

// sessionCaptureMiddleware captures the session ID and Router JWT from the incoming
// request headers. The JWT is reused by EnvD to authenticate against WM's internal
// policy API (replacing the previous static INTERNAL_API_TOKEN approach).
// Runs after jwtMiddleware — the Authorization header is still readable.
//
// IMPORTANT: JWT must be captured BEFORE setSessionID, because setSessionID
// triggers the policy fetch goroutine which needs the JWT for WM authentication.
func (s *Server) sessionCaptureMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if auth := r.Header.Get("Authorization"); strings.HasPrefix(auth, "Bearer ") {
			s.inference.setJWTToken(auth[len("Bearer "):])
		}
		if sid := r.Header.Get("x-session-id"); sid != "" {
			s.inference.setSessionID(sid)
		}
		next.ServeHTTP(w, r)
	})
}

// Run starts the HTTP server (and egress proxy if enabled) and blocks until ctx is done.
func (s *Server) Run(ctx context.Context) error {
	// §4.1: Init phase — add envd-proxy GID, set up iptables, start transparent proxy.
	if s.egressEnabled {
		if s.auditReporter != nil {
			go s.auditReporter.Run(ctx)
		}
		log.Info("egress: init phase — adding envd-proxy supplementary group")
		if err := egress.AddEnvDProxyGroup(); err != nil {
			return fmt.Errorf("egress add proxy group: %w", err)
		}

		log.Info("egress: configuring iptables REDIRECT rules")
		if err := egress.SetupIPTables(); err != nil {
			return fmt.Errorf("egress iptables setup: %w", err)
		}

		log.Info("egress: dropping CAP_NET_ADMIN and CAP_NET_RAW")
		if err := egress.DropNetCapabilities(); err != nil {
			log.Warn("egress: capability drop failed (non-fatal in dev)", "error", err)
		}

		go func() {
			if err := s.egressProxy.Run(ctx); err != nil {
				log.Error("egress: proxy exited with error", "error", err)
			}
		}()

		// Start policy syncer — pulls egress policy from WM every 30s.
		// Uses session ID and JWT captured by sessionCaptureMiddleware.
		if s.policyEngine != nil {
			go func() {
				// Wait for first request to capture session ID and JWT
				log.Info("egress: policy syncer waiting for session ID from first request...")
				s.inference.waitForReady()
				sid := s.inference.getSessionID()
				jwt := s.inference.getJWTToken()
				wmURL := s.inference.getWMURL()
				if sid != "" && wmURL != "" {
					syncer := NewPolicySyncer(s.policyEngine, s.egressProxy.SSRFChecker(), wmURL, sid, jwt)
					s.policySyncer = syncer
					log.Info("egress: starting policy syncer", "sessionId", sid)
					syncer.Run(ctx)
				} else {
					log.Warn("egress: policy syncer not started (no session ID or WM URL)")
				}
			}()
		}
	}

	srv := &http.Server{
		Addr:    fmt.Sprintf(":%d", s.port),
		Handler: s.Handler(),
	}

	errCh := make(chan error, 1)
	go func() {
		errCh <- srv.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		// Logged before Shutdown closes the listeners, because that is the
		// moment the sandbox stops answering: without this line the only
		// outward sign is the readiness probe flipping to connection refused,
		// which says nothing about whether envd was signalled or died.
		// Defended here rather than trusting the field: a Server built as a literal
		// bypasses New's fallback, and context.WithTimeout(ctx, 0) is already
		// expired -- it would cut every in-flight request instantly.
		drain := s.drainTimeout
		if drain <= 0 {
			drain = defaultShutdownDrainTimeout
		}
		log.Info("envd: shutdown signal received, draining", "timeout", drain)

		// Armed before the first step that can block, so the bound covers the whole
		// shutdown instead of just the drain. Exit 0: this is a signalled stop that
		// ran out of time, not a failure, and the log line above says what happened.
		budget := drain + shutdownHardExitGrace
		hardExit := time.AfterFunc(budget, func() {
			log.Error("envd: shutdown exceeded its budget, exiting anyway", "budget", budget)
			os.Exit(0)
		})
		defer hardExit.Stop()

		// Deferred rather than run here, so the egress rules outlive the drain: a
		// request still in flight is still the agent's traffic, and tearing the rules
		// down first would let its last few seconds out unfiltered. Deferred rather
		// than moved below the drain because there are two ways out of it. Safe to
		// leave until the end because the bound above covers it -- iptables blocking
		// on the xtables lock is the reason that timer exists.
		if s.egressEnabled {
			defer egress.CleanupIPTables()
		}
		drainCtx, cancelDrain := context.WithTimeout(context.Background(), drain)
		defer cancelDrain()
		if err := srv.Shutdown(drainCtx); err != nil {
			// A request outlived the drain -- a long agent command, typically.
			// Closing it is the point: the listeners are already gone, so
			// waiting longer serves nobody and only keeps PID 1 alive.
			log.Warn("envd: drain timed out, closing remaining connections", "error", err)
			// Close's own error is dropped rather than returned: reaching the bound
			// is a successful shutdown, already reported on the line above, while
			// main treats any non-nil error here as a failure and exits 1. Close can
			// return one by re-closing a listener Shutdown has already removed.
			_ = srv.Close()
			return nil
		}
		return nil
	case err := <-errCh:
		return err
	}
}

// handleHealth handles GET /health
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func httpError(w http.ResponseWriter, msg string, status int) {
	writeJSON(w, status, ErrorResponse{Error: msg})
}
