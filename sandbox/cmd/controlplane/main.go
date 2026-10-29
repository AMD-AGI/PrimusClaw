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

	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/dynamic/dynamicinformer"
	"k8s.io/client-go/kubernetes"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"

	sandboxv1alpha1 "sigs.k8s.io/agent-sandbox/api/v1alpha1"
	"sigs.k8s.io/agent-sandbox/controllers"
	extensionsv1alpha1 "sigs.k8s.io/agent-sandbox/extensions/api/v1alpha1"
	extensionscontrollers "sigs.k8s.io/agent-sandbox/extensions/controllers"
	asmetrics "sigs.k8s.io/agent-sandbox/internal/metrics"
	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/audit"
	"sigs.k8s.io/agent-sandbox/pkg/builder"
	"sigs.k8s.io/agent-sandbox/pkg/e2b"
	"sigs.k8s.io/agent-sandbox/pkg/grant"
	"sigs.k8s.io/agent-sandbox/pkg/identity"
	log "sigs.k8s.io/agent-sandbox/pkg/logx"
	"sigs.k8s.io/agent-sandbox/pkg/nsadmission"
	"sigs.k8s.io/agent-sandbox/pkg/router"
	"sigs.k8s.io/agent-sandbox/pkg/safe"
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

// namespaceSelectorFromEnv returns the namespace selector to enforce: the
// NAMESPACE_SELECTOR environment variable (how the chart passes it) when set,
// otherwise the --namespace-selector flag value. An unparseable selector is an
// error, never "no selector", so a typo cannot fail open.
func namespaceSelectorFromEnv(flagValue string) (labels.Selector, error) {
	if v := os.Getenv(nsadmission.EnvVar); v != "" {
		flagValue = v
	}
	return nsadmission.ParseSelector(flagValue)
}

// wireNamespaceAdmission starts one Admitter for selector and hands it to both
// the Router and the Workload Manager. A nil selector leaves both unset, which
// admits every namespace.
func wireNamespaceAdmission(ctx context.Context, client kubernetes.Interface, selector labels.Selector,
	routerCfg *router.Config, wmCfg *workloadmanager.Config) *nsadmission.Admitter {
	admitter := nsadmission.New(client, selector)
	if admitter == nil {
		log.Info("namespace admission disabled: no namespace selector, every namespace is served")
		return nil
	}
	admitter.Start(ctx)
	routerCfg.Namespaces = admitter
	wmCfg.Namespaces = admitter
	log.Info("namespace admission enabled", "selector", admitter.Selector())
	return admitter
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
	var metricsAddr string
	var probeAddr string
	var enableLeaderElection bool
	var stopGrace time.Duration
	var enableExtensions bool
	// Accepted and ignored for one release. Sandbox idle reclaim is Brain's,
	// driven by EnvD's jobs roster, and nothing here reads this any more --
	// but an unknown argument ends flag.Parse in os.Exit(2), before a single
	// listener or controller starts. A Deployment that still carries this one
	// would take the whole control plane down on an image bump alone, so it is
	// parsed and reported rather than refused. Remove in the next release.
	var deprecatedSessionTimeout time.Duration
	var namespaceSelector string
	var deprecatedEnableIdleGC bool

	routerPort = 8080
	wmPort = 8081

	flag.IntVar(&routerPort, "router-port", routerPort, "HTTP listen port for the Router API")
	flag.IntVar(&wmPort, "wm-port", wmPort, "HTTP listen port for the internal Workload Manager API")
	flag.IntVar(&routerCfg.MaxConcurrentRequests, "max-concurrent-requests", routerCfg.MaxConcurrentRequests, "Max concurrent Router requests")
	flag.BoolVar(&routerCfg.EnableAuth, "enable-auth", routerCfg.EnableAuth, "Enable SaFE API Key authentication")
	flag.StringVar(&routerCfg.SafeAPIURL, "safe-api-url", routerCfg.SafeAPIURL, "SaFE API server URL")
	flag.StringVar(&namespaceSelector, "namespace-selector", "",
		"Label selector (kubectl -l syntax) of the namespaces the Router and Workload Manager serve; "+
			"empty serves every namespace. Overridden by "+nsadmission.EnvVar)
	flag.StringVar(&wmCfg.Namespace, "namespace", wmCfg.Namespace, "K8s namespace for system components")
	flag.DurationVar(&wmCfg.GCInterval, "gc-interval", wmCfg.GCInterval, "GC scan interval")
	flag.DurationVar(&wmCfg.DefaultTTL, "default-ttl", wmCfg.DefaultTTL, "Default sandbox TTL")
	flag.StringVar(&metricsAddr, "metrics-bind-address", ":8082", "Metrics bind address for the controller manager")
	flag.StringVar(&probeAddr, "health-probe-bind-address", ":8083", "Health probe bind address for the controller manager")
	flag.BoolVar(&enableLeaderElection, "leader-elect", true, "Enable leader election for the unified controlplane")
	flag.BoolVar(&enableExtensions, "extensions", true, "Enable SandboxClaim and SandboxWarmPool controllers")
	flag.DurationVar(&deprecatedSessionTimeout, "session-timeout", 0,
		"Deprecated and ignored: sandbox idle reclaim is owned by Brain")
	// Accepted so manifests that still pass --enable-idle-gc=false (this PR's
	// earlier deployables) do not CrashLoop on flag.Parse. The controller is
	// not wired: LastActivity is not refreshed, and Brain owns idle reclaim.
	flag.BoolVar(&deprecatedEnableIdleGC, "enable-idle-gc", false,
		"Deprecated and ignored: sandbox idle reclaim is owned by Brain")
	flag.DurationVar(&routerCfg.ShutdownDelay, "shutdown-delay", 0,
		"After SIGTERM, keep accepting Router requests this long with /health/ready failing, "+
			"so endpoints and the gateway drop the replica before the listener closes")
	flag.DurationVar(&routerCfg.ShutdownTimeout, "shutdown-timeout", router.DefaultShutdownTimeout,
		"After the shutdown delay, how long in-flight Router requests may run before they are closed")
	flag.DurationVar(&stopGrace, "shutdown-stop-grace", defaultStopGrace,
		"After the Router has drained, how long the Workload Manager and controllers may take to stop. "+
			"terminationGracePeriodSeconds must cover preStop + shutdown-delay + shutdown-timeout + this")
	flag.Parse()

	// Said out loud, because the environment variable never failed at all: a
	// deployment that set it has been reading a lifetime nothing enforces.
	if deprecatedSessionTimeout != 0 || os.Getenv("SESSION_TIMEOUT") != "" {
		fmt.Fprintln(os.Stderr,
			"WARNING: session-timeout is ignored. Sandbox idle reclaim is owned by Brain "+
				"(EnvD GET /api/jobs); only the hard --default-ttl applies here.")
	}
	idleGCFlagSet := false
	flag.Visit(func(f *flag.Flag) {
		if f.Name == "enable-idle-gc" {
			idleGCFlagSet = true
		}
	})
	if idleGCFlagSet || os.Getenv("ENABLE_SANDBOX_IDLE_GC") != "" {
		fmt.Fprintln(os.Stderr,
			"WARNING: enable-idle-gc is ignored. Sandbox idle reclaim is owned by Brain "+
				"(EnvD GET /api/jobs); the control-plane idle-GC controller is not wired.")
	}

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
	// Parsed before anything starts: a selector that does not parse must stop
	// the process, not degrade to admitting every namespace.
	nsSelector, err := namespaceSelectorFromEnv(namespaceSelector)
	if err != nil {
		log.Error("namespace admission refused", "error", err)
		os.Exit(1)
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

	// sigCtx ends on the signal and drives only the Router's drain; ctx is the
	// lifetime of everything the Router depends on and ends after the drain
	// (see runUntilSignal). During startup a signal still aborts at once.
	sigCtx, sigCancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer sigCancel()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stopStartupAbort := context.AfterFunc(sigCtx, cancel)

	k8sCfg := ctrl.GetConfigOrDie()
	mgr, err := ctrl.NewManager(k8sCfg, managerOptions(metricsAddr, probeAddr, enableLeaderElection))
	if err != nil {
		log.Error("unable to create manager", "error", err)
		os.Exit(1)
	}

	// Audit events go to process logs (see audit.LogEvent). No durable store.
	if wmCfg.Audit.Enabled {
		audit.BackendUp.Set(1)
	} else {
		audit.BackendUp.Set(0)
	}

	clientset, err := kubernetes.NewForConfig(k8sCfg)
	if err != nil {
		log.Error("failed to create K8s clientset", "error", err)
		os.Exit(1)
	}

	workloadmanager.InitPublicKeyCache(ctx, clientset)

	// Shared by the Router and the Workload Manager. Not waited for here: until
	// it syncs every namespaced request is refused with 503 and the Router's
	// readiness probe fails, so the replica takes no traffic it cannot judge.
	// Only readiness waits for it; the startup and liveness probes do not, so a
	// cache that never syncs leaves the replica unready rather than restarting.
	wireNamespaceAdmission(ctx, clientset, nsSelector, &routerCfg, &wmCfg)

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
		Client:   mgr.GetClient(),
		Scheme:   mgr.GetScheme(),
		Tracer:   tracer,
		AuditLog: wmCfg.Audit.Enabled,
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

	// Session routing reads Sandbox CRs (namespace/name). MemoryStore is only
	// for the rare path where the K8s client cannot be constructed.
	var (
		st  store.Store
		k8s *workloadmanager.K8sSandboxCreator
	)
	if creator, err := workloadmanager.NewK8sSandboxCreator(k8sCfg); err != nil {
		log.Warn("K8s sandbox creator init failed; using in-memory session store", "error", err)
		st = store.NewMemoryStore()
	} else {
		k8s = creator.WithInformers(crdInformers)
		if err := workloadmanager.IndexSandboxesBySessionID(ctx, mgr.GetFieldIndexer()); err != nil {
			log.Warn("session-id index unavailable; lookups will list sandboxes instead", "error", err)
		} else {
			k8s.WithCachedReader(mgr.GetClient())
		}
		crStore := workloadmanager.NewCRStore(k8s)
		if wmCfg.Namespaces != nil {
			crStore.WithNamespaceFilter(wmCfg.Namespaces.Filter)
		}
		st = crStore
	}
	workloads := workloadmanager.NewSafeWorkloadCreator(dynamicClient, mgr.GetClient())
	st = workloadmanager.NewWorkloadSessionStore(st, workloads)
	defer st.Close()

	wmSandboxReconciler := &workloadmanager.SandboxReconciler{
		Client: mgr.GetClient(),
		Scheme: mgr.GetScheme(),
		Store:  st,
	}
	if err := wmSandboxReconciler.SetupWithManager(mgr); err != nil {
		log.Error("unable to setup session Sandbox controller", "error", err)
		os.Exit(1)
	}
	if k8s != nil {
		k8s.WithReconciler(wmSandboxReconciler)
	}

	// Sandbox idle-GC is not wired: Brain reclaim (GET /api/jobs + idle window)
	// owns sandbox lifetime. LastActivity is not refreshed for GC.

	if err := mgr.AddHealthzCheck("healthz", healthz.Ping); err != nil {
		log.Error("unable to set up health check", "error", err)
		os.Exit(1)
	}
	if err := mgr.AddReadyzCheck("readyz", healthz.Ping); err != nil {
		log.Error("unable to set up ready check", "error", err)
		os.Exit(1)
	}

	apiServer := workloadmanager.New(wmCfg, st)
	if registry := os.Getenv("SANDBOX_IMAGE_REGISTRY"); registry != "" {
		builderCfg := builder.DefaultConfig()
		builderCfg.Registry = registry
		builderCfg.Namespace = wmCfg.Namespace
		if secret := os.Getenv("REGISTRY_SECRET"); secret != "" {
			builderCfg.RegistrySecret = secret
		}
		// Content-hash cache is optional (NopCache). Kaniko's --cache-repo
		// still applies when builderCfg.CacheRepo is set.
		apiServer.WithBuilder(builder.New(builderCfg, mgr.GetClient(), builder.NewNopCache()))
	}
	if k8s != nil {
		apiServer.WithK8s(k8s)
	}
	apiServer.WithSafeWorkloads(workloads)

	routerServer, err := router.New(ctx, routerCfg, st, clientset)
	if err != nil {
		log.Error("router init failed", "error", err)
		os.Exit(1)
	}
	if err := routerServer.ConfigureDataPlane(
		os.Getenv(router.EnvClusterID),
		os.Getenv(router.EnvClusterRoutes),
		os.Getenv(router.EnvUpstreamPublicKey),
		workloadmanager.NewPodAddressFinder(mgr.GetClient()).PodAddress,
	); err != nil {
		log.Error("dataplane route config failed", "error", err)
		os.Exit(1)
	}
	workloads.SetRemoteClusters(routerServer.RemoteClusterIDs())

	grants, err := startGrants(ctx, mgr.GetClient(), mgr.GetAPIReader(), clientset, dynamicClient, apiServer, st, workloads, wmCfg.Namespace)
	if err != nil {
		log.Error("grant service init failed", "error", err)
		os.Exit(1)
	}

	if grants != nil {
		routerServer.WithGrants(grants)
		idClient, err := ownerKeys(ctx, grants)
		if err != nil {
			log.Error("identity key init failed", "error", err)
			os.Exit(1)
		}
		opts := e2b.Options{
			Grants:    grants,
			Runner:    apiServer,
			Namespace: grant.Namespace(wmCfg.Namespace),
		}
		if idClient != nil {
			opts.Identity = idClient
		}
		plane := e2b.New(opts)
		grants.SetPromoter(plane)
		apiServer.WithE2B(plane)
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

	if !stopStartupAbort() {
		log.Info("controlplane stopped during startup")
		return
	}
	err = runUntilSignal(sigCtx, ctx, cancel,
		component{name: "router", run: routerServer.Run},
		[]component{
			{name: "workload-manager API", run: apiServer.Run},
			managerComponent(mgr.Start),
		},
		stopGrace)
	if err != nil {
		log.Error("controlplane exited with error", "error", err)
		os.Exit(1)
	}
	log.Info("controlplane shutdown complete")
}

// ownerKeys enables primus-identity keys when both the introspection client and
// the owner policy are configured. It returns nil when either is absent.
func ownerKeys(ctx context.Context, grants *grant.Service) (*identity.Client, error) {
	client, err := identity.FromEnv()
	if err != nil || client == nil {
		return nil, err
	}
	policy, err := grant.OwnerPolicyFromEnv()
	if err != nil {
		return nil, err
	}
	if policy == nil {
		log.Warn("identity keys disabled: owner policy is not configured")
		return nil, nil
	}
	if err := grants.SetOwnerPolicy(ctx, *policy); err != nil {
		return nil, err
	}
	log.Info("identity keys enabled", "role", grants.OwnerRole())
	return client, nil
}

// startGrants serves the grant admin API from SandboxGrant CRs and reaps
// expired grants. Claw remains the authority; this process keeps the
// execution copy.
func startGrants(ctx context.Context, cl ctrlclient.Client, reader ctrlclient.Reader, clientset kubernetes.Interface, dyn dynamic.Interface, api *workloadmanager.Server, st store.Store, workloads *workloadmanager.SafeWorkloadCreator, namespace string) (*grant.Service, error) {
	dataKey, err := grant.DataKeyFromEnv()
	if err != nil {
		return nil, fmt.Errorf("GRANT_DATA_KEY: %w", err)
	}
	jwks, err := grant.JWKSFromEnv()
	if err != nil {
		return nil, fmt.Errorf("grant JWKS: %w", err)
	}
	var attest grant.AttestationChecker
	if len(jwks) > 0 {
		attest, err = grant.NewJWKSChecker(jwks)
		if err != nil {
			return nil, fmt.Errorf("grant JWKS: %w", err)
		}
	}
	var identity grant.IdentityChecker
	if url := os.Getenv("SAFE_API_URL"); url != "" {
		identity = grant.NewSafeIdentityChecker(safe.NewClient(url))
	}
	var membership grant.MembershipChecker
	if dyn != nil {
		membership = grant.NewUserCRMembership(dyn)
	}
	ns := grant.Namespace(namespace)
	svc := grant.New(grant.Options{
		Client:     cl,
		Reader:     reader,
		Namespace:  ns,
		DataKey:    dataKey,
		Authn:      grant.NewTokenReviewAuthenticator(clientset, grant.AllowedCallersFromEnv()),
		Attest:     attest,
		Identity:   identity,
		Membership: membership,
		Reclaimer:  workloadmanager.NewGrantReclaimer(api),
		Exists:     workloadmanager.NewGrantExists(st, workloads),
		Record:     api,
	})
	api.WithGrants(svc)
	go svc.Run(ctx, 30*time.Second)
	log.Info("grant service started", "namespace", ns)
	return svc, nil
}
