// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	_ "k8s.io/client-go/plugin/pkg/client/auth"

	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/dynamic/dynamicinformer"
	"k8s.io/client-go/kubernetes"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	sandboxv1alpha1 "sigs.k8s.io/agent-sandbox/api/v1alpha1"
	"sigs.k8s.io/agent-sandbox/controllers"
	extensionsv1alpha1 "sigs.k8s.io/agent-sandbox/extensions/api/v1alpha1"
	extensionscontrollers "sigs.k8s.io/agent-sandbox/extensions/controllers"
	asmetrics "sigs.k8s.io/agent-sandbox/internal/metrics"
	"sigs.k8s.io/agent-sandbox/pkg/agentd"
	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/audit"
	"sigs.k8s.io/agent-sandbox/pkg/builder"
	log "sigs.k8s.io/agent-sandbox/pkg/logx"
	"sigs.k8s.io/agent-sandbox/pkg/router"
	"sigs.k8s.io/agent-sandbox/pkg/store"
	"sigs.k8s.io/agent-sandbox/pkg/workloadmanager"
)

var scheme = runtime.NewScheme()

// checkAuthPosture refuses to start in a configuration that exposes sandbox
// creation and in-sandbox command execution to unauthenticated callers.
//
// With EnableAuth=false neither the Router nor the Workload Manager registers
// any auth middleware (see pkg/router/server.go and
// pkg/workloadmanager/server.go), so every caller that can reach the service can
// create sandboxes and exec arbitrary commands inside them. There is no
// network-level backstop either: the reference deployment runs the Flannel CNI,
// which has no NetworkPolicy support. That posture is fine on a throwaway
// development cluster but must never be reached by accident, so it now requires
// an explicit ALLOW_INSECURE_NO_AUTH=true acknowledgement.
func checkAuthPosture(cfg *router.Config) error {
	if cfg.EnableAuth {
		if cfg.SafeAPIURL == "" {
			return fmt.Errorf("ENABLE_AUTH=true requires SAFE_API_URL to be set")
		}
		return nil
	}
	if os.Getenv("ALLOW_INSECURE_NO_AUTH") != "true" {
		return fmt.Errorf("authentication is disabled: set ENABLE_AUTH=true together with " +
			"SAFE_API_URL, or acknowledge the risk explicitly with ALLOW_INSECURE_NO_AUTH=true")
	}
	log.Warn("AUTHENTICATION IS DISABLED (ALLOW_INSECURE_NO_AUTH=true): any client that can " +
		"reach the Router or Workload Manager can create sandboxes and execute code inside them. " +
		"Never use this configuration outside an isolated development cluster.")
	return nil
}

func init() {
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
	utilruntime.Must(sandboxv1alpha1.AddToScheme(scheme))
	utilruntime.Must(extensionsv1alpha1.AddToScheme(scheme))
	utilruntime.Must(runtimev1alpha1.AddToScheme(scheme))
}

func main() {
	routerCfg := router.DefaultConfig()
	wmCfg := workloadmanager.DefaultConfig()

	var routerPort int
	var wmPort int
	var sessionTimeout time.Duration
	var metricsAddr string
	var probeAddr string
	var enableLeaderElection bool
	var enableExtensions bool

	routerPort = 8080
	wmPort = 8081
	sessionTimeout = agentd.DefaultSessionTimeout

	flag.IntVar(&routerPort, "router-port", routerPort, "HTTP listen port for the Router API")
	flag.IntVar(&wmPort, "wm-port", wmPort, "HTTP listen port for the internal Workload Manager API")
	flag.IntVar(&routerCfg.MaxConcurrentRequests, "max-concurrent-requests", routerCfg.MaxConcurrentRequests, "Max concurrent Router requests")
	flag.BoolVar(&routerCfg.EnableAuth, "enable-auth", routerCfg.EnableAuth, "Enable SaFE API Key authentication")
	flag.StringVar(&routerCfg.SafeAPIURL, "safe-api-url", routerCfg.SafeAPIURL, "SaFE API server URL")
	flag.StringVar(&wmCfg.Namespace, "namespace", wmCfg.Namespace, "K8s namespace for system components")
	flag.DurationVar(&wmCfg.GCInterval, "gc-interval", wmCfg.GCInterval, "GC scan interval")
	flag.DurationVar(&wmCfg.DefaultTTL, "default-ttl", wmCfg.DefaultTTL, "Default sandbox TTL")
	flag.DurationVar(&sessionTimeout, "session-timeout", sessionTimeout, "Idle timeout after which a Sandbox is deleted")
	flag.StringVar(&metricsAddr, "metrics-bind-address", ":8082", "Metrics bind address for the controller manager")
	flag.StringVar(&probeAddr, "health-probe-bind-address", ":8083", "Health probe bind address for the controller manager")
	flag.BoolVar(&enableLeaderElection, "leader-elect", true, "Enable leader election for the unified controlplane")
	flag.BoolVar(&enableExtensions, "extensions", true, "Enable SandboxClaim and SandboxWarmPool controllers")
	flag.Parse()

	// controller-runtime keeps zap here, deliberately: switching it to the
	// shared handler changes the format of every line this binary emits, and
	// whatever ingests those lines was not part of this change. envd, which
	// has no such consumer, calls log.Install.
	//
	// This is about where records go. Escaping happens in logx before any
	// logger is called, so it is unaffected -- see pkg/log.
	ctrl.SetLogger(zap.New(zap.UseDevMode(true)))

	if v := os.Getenv("AGENT_SANDBOX_NAMESPACE"); v != "" {
		wmCfg.Namespace = v
	}
	if v := os.Getenv("ENABLE_AUTH"); v == "true" {
		routerCfg.EnableAuth = true
	}
	if v := os.Getenv("SAFE_API_URL"); v != "" {
		routerCfg.SafeAPIURL = v
	}
	if v := os.Getenv("GC_INTERVAL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			wmCfg.GCInterval = d
		}
	}
	if v := os.Getenv("DEFAULT_TTL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			wmCfg.DefaultTTL = d
		}
	}
	if v := os.Getenv("SESSION_TIMEOUT"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			sessionTimeout = d
		}
	}

	if os.Getenv("INFERENCE_ENABLED") == "true" {
		wmCfg.Inference.Enabled = true
		wmCfg.Inference.LiteLLMEndpoint = os.Getenv("INFERENCE_LITELLM_ENDPOINT")
	}
	wmCfg.Audit.Enabled = os.Getenv("AUDIT_ENABLED") != "false"
	wmCfg.Audit.RetentionDays = 30
	if v := os.Getenv("AUDIT_RETENTION_DAYS"); v != "" {
		if d, err := strconv.Atoi(v); err == nil && d > 0 {
			wmCfg.Audit.RetentionDays = d
		}
	}
	wmCfg.Audit.ResourceFetchTimeout = 5 * time.Second
	if v := os.Getenv("AUDIT_RESOURCE_FETCH_TIMEOUT"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			wmCfg.Audit.ResourceFetchTimeout = d
		}
	}

	routerCfg.Port = routerPort
	routerCfg.Namespace = wmCfg.Namespace
	routerCfg.WorkloadManagerURL = fmt.Sprintf("http://127.0.0.1:%d", wmPort)
	wmCfg.Port = wmPort
	wmCfg.EnableAuth = routerCfg.EnableAuth
	wmCfg.SafeAPIURL = routerCfg.SafeAPIURL

	if err := checkAuthPosture(&routerCfg); err != nil {
		log.Error("insecure configuration refused", "error", err)
		os.Exit(1)
	}

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	k8sCfg := ctrl.GetConfigOrDie()
	mgr, err := ctrl.NewManager(k8sCfg, ctrl.Options{
		Scheme: scheme,
		Metrics: metricsserver.Options{
			BindAddress: metricsAddr,
		},
		HealthProbeBindAddress: probeAddr,
		LeaderElection:         enableLeaderElection,
		LeaderElectionID:       "agent-sandbox-controlplane.agent-sandbox.io",
	})
	if err != nil {
		log.Error("unable to create manager", "error", err)
		os.Exit(1)
	}

	st, err := store.NewFromEnv()
	if err != nil {
		log.Error("failed to initialize store", "error", err)
		os.Exit(1)
	}
	defer st.Close()

	if err := st.Ping(ctx); err != nil {
		log.Error("store ping failed", "error", err)
		os.Exit(1)
	}

	// Shared audit backend (API, agentd, sandbox runtime controller). nil when disabled or non-Redis store.
	var auditStore audit.AuditStore
	if wmCfg.Audit.Enabled {
		if rs, ok := st.(*store.RedisStore); ok {
			auditStore = audit.NewRedisStore(rs.Client(), wmCfg.Audit.RetentionDays)
		} else {
			log.Warn("audit logging requires Redis store; disabled in memory mode")
		}
	}

	clientset, err := kubernetes.NewForConfig(k8sCfg)
	if err != nil {
		log.Error("failed to create K8s clientset", "error", err)
		os.Exit(1)
	}

	workloadmanager.InitPublicKeyCache(ctx, clientset)

	dynamicClient, err := dynamic.NewForConfig(k8sCfg)
	if err != nil {
		log.Error("failed to create dynamic client", "error", err)
		os.Exit(1)
	}
	dynamicFactory := dynamicinformer.NewDynamicSharedInformerFactory(dynamicClient, 0)
	crdInformers := workloadmanager.NewCRDInformers(dynamicFactory)
	if err := crdInformers.RunAndWaitForCacheSync(ctx); err != nil {
		log.Error("CRD informer cache sync failed", "error", err)
		os.Exit(1)
	}

	tracer := asmetrics.NewNoOp()

	if err := (&controllers.SandboxReconciler{
		Client: mgr.GetClient(),
		Scheme: mgr.GetScheme(),
		Tracer: tracer,
		Audit:  auditStore,
	}).SetupWithManager(mgr); err != nil {
		log.Error("unable to setup Sandbox controller", "error", err)
		os.Exit(1)
	}

	if enableExtensions {
		if err := (&extensionscontrollers.SandboxClaimReconciler{
			Client:   mgr.GetClient(),
			Scheme:   mgr.GetScheme(),
			Recorder: mgr.GetEventRecorderFor("sandboxclaim-controller"),
			Tracer:   tracer,
		}).SetupWithManager(mgr); err != nil {
			log.Error("unable to setup SandboxClaim controller", "error", err)
			os.Exit(1)
		}

		if err := (&extensionscontrollers.SandboxWarmPoolReconciler{
			Client: mgr.GetClient(),
		}).SetupWithManager(mgr); err != nil {
			log.Error("unable to setup SandboxWarmPool controller", "error", err)
			os.Exit(1)
		}
	}

	if err := (&workloadmanager.CodeInterpreterReconciler{
		Client: mgr.GetClient(),
		Scheme: mgr.GetScheme(),
	}).SetupWithManager(mgr); err != nil {
		log.Error("unable to setup CodeInterpreter controller", "error", err)
		os.Exit(1)
	}

	wmSandboxReconciler := &workloadmanager.SandboxReconciler{
		Client: mgr.GetClient(),
		Scheme: mgr.GetScheme(),
		Store:  st,
	}
	if err := wmSandboxReconciler.SetupWithManager(mgr); err != nil {
		log.Error("unable to setup session Sandbox controller", "error", err)
		os.Exit(1)
	}

	if err := (&agentd.SandboxReconciler{
		Client:         mgr.GetClient(),
		Scheme:         mgr.GetScheme(),
		SessionTimeout: sessionTimeout,
		Store:          st,
		Audit:          auditStore,
		Recorder:       mgr.GetEventRecorderFor("sandbox-idle-gc"),
	}).SetupWithManager(mgr); err != nil {
		log.Error("unable to setup idle GC controller", "error", err)
		os.Exit(1)
	}

	if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
		log.Error("unable to set up health check", "error", err)
		os.Exit(1)
	}
	if err := mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
		log.Error("unable to set up ready check", "error", err)
		os.Exit(1)
	}

	apiServer := workloadmanager.New(wmCfg, st)
	if auditStore != nil {
		apiServer.WithAuditStore(auditStore)
	}
	if registry := os.Getenv("SANDBOX_IMAGE_REGISTRY"); registry != "" {
		builderCfg := builder.DefaultConfig()
		builderCfg.Registry = registry
		builderCfg.Namespace = wmCfg.Namespace
		if secret := os.Getenv("REGISTRY_SECRET"); secret != "" {
			builderCfg.RegistrySecret = secret
		}
		if rs, ok := st.(*store.RedisStore); ok {
			apiServer.WithBuilder(builder.New(builderCfg, mgr.GetClient(), builder.NewRedisCache(rs.Client())))
		}
	}
	if k8s, err := workloadmanager.NewK8sSandboxCreator(k8sCfg); err == nil {
		k8s.WithReconciler(wmSandboxReconciler)
		k8s.WithInformers(crdInformers)
		// Session recovery resolves a session id to its Sandbox, which the keepalive
		// poll reaches once per session per minute while the store cannot answer.
		// Registered against the cache the controllers already fill, so this costs
		// no extra watch; without the index the lookup falls back to listing.
		if err := workloadmanager.IndexSandboxesBySessionID(ctx, mgr.GetFieldIndexer()); err != nil {
			log.Warn("session-id index unavailable; recovery will list sandboxes instead", "error", err)
		} else {
			k8s.WithCachedReader(mgr.GetClient())
		}
		apiServer.WithK8s(k8s)
	} else {
		log.Warn("K8s sandbox creator init failed; running in dev mode", "error", err)
	}

	routerServer, err := router.New(ctx, routerCfg, st, clientset)
	if err != nil {
		log.Error("router init failed", "error", err)
		os.Exit(1)
	}

	// Sandbox health watcher — exposes pod health as Prometheus metrics
	watcherCfg := workloadmanager.DefaultWatcherConfig()
	if v := os.Getenv("SANDBOX_WATCH_INTERVAL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			watcherCfg.Interval = d
		}
	}
	watcherCfg.Namespace = wmCfg.Namespace
	if watcher := workloadmanager.NewSandboxWatcher(watcherCfg, st, clientset); watcher != nil {
		go watcher.Run(ctx)
	}

	errCh := make(chan error, 3)
	go func() {
		log.Info("router starting", "port", routerCfg.Port)
		if err := routerServer.Run(ctx); err != nil && err.Error() != "http: Server closed" {
			errCh <- fmt.Errorf("router: %w", err)
		}
	}()
	go func() {
		log.Info("workload-manager API starting", "port", wmCfg.Port)
		if err := apiServer.Run(ctx); err != nil && err.Error() != "http: Server closed" {
			errCh <- fmt.Errorf("workload-manager: %w", err)
		}
	}()
	go func() {
		log.Info("controller manager starting", "metrics", metricsAddr, "probe", probeAddr)
		if err := mgr.Start(ctx); err != nil {
			errCh <- fmt.Errorf("manager: %w", err)
		}
	}()

	select {
	case <-ctx.Done():
		log.Info("controlplane shutdown complete")
	case err := <-errCh:
		log.Error("controlplane exited with error", "error", err)
		cancel()
		os.Exit(1)
	}
}
