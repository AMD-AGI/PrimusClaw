// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/util/intstr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/log"

	sandboxv1alpha1 "sigs.k8s.io/agent-sandbox/api/v1alpha1"
	extensionsv1alpha1 "sigs.k8s.io/agent-sandbox/extensions/api/v1alpha1"
	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
)

// CodeInterpreterReconciler reconciles CodeInterpreter objects.
// When a CodeInterpreter is created/updated, it ensures a matching
// SandboxTemplate and (optionally) SandboxWarmPool exist.
//
// +kubebuilder:rbac:groups=runtime.agent-sandbox.io,resources=codeinterpreters,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=runtime.agent-sandbox.io,resources=codeinterpreters/status,verbs=get;update;patch
// +kubebuilder:rbac:groups=extensions.agents.x-k8s.io,resources=sandboxtemplates,verbs=get;list;watch;create;update;patch;delete
// +kubebuilder:rbac:groups=extensions.agents.x-k8s.io,resources=sandboxwarmpools,verbs=get;list;watch;create;update;patch;delete
type CodeInterpreterReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

// Reconcile is the main reconcile loop.
func (r *CodeInterpreterReconciler) Reconcile(ctx context.Context, req ctrl.Request) (ctrl.Result, error) {
	logger := log.FromContext(ctx)

	ci := &runtimev1alpha1.CodeInterpreter{}
	if err := r.Get(ctx, req.NamespacedName, ci); err != nil {
		if errors.IsNotFound(err) {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{}, err
	}

	logger.Info("reconciling CodeInterpreter", "name", ci.Name, "namespace", ci.Namespace)

	if ci.Spec.Template == nil {
		return ctrl.Result{}, fmt.Errorf("spec.template is required")
	}

	// Wait for Router public key to be cached (required for EnvD auth, unless authMode=none)
	if ci.Spec.AuthMode != runtimev1alpha1.AuthModeNone && !IsPublicKeyCached() {
		logger.Info("waiting for Router public key to be cached; will retry in 5s")
		return ctrl.Result{RequeueAfter: 5 * time.Second}, nil
	}

	// Always ensure a SandboxTemplate
	if err := r.ensureSandboxTemplate(ctx, ci); err != nil {
		logger.Error(err, "failed to ensure SandboxTemplate")
		return ctrl.Result{}, err
	}

	// Manage WarmPool based on warmPoolSize
	if ci.Spec.WarmPoolSize != nil && *ci.Spec.WarmPoolSize > 0 {
		if err := r.ensureSandboxWarmPool(ctx, ci); err != nil {
			logger.Error(err, "failed to ensure SandboxWarmPool")
			return ctrl.Result{}, err
		}
	} else {
		// Remove WarmPool if size is 0 or unset
		if err := r.deleteSandboxWarmPool(ctx, ci); err != nil {
			logger.Error(err, "failed to delete SandboxWarmPool")
			return ctrl.Result{}, err
		}
	}

	// Update status
	if err := r.updateReadyStatus(ctx, ci); err != nil {
		logger.Error(err, "failed to update status")
		return ctrl.Result{}, err
	}

	return ctrl.Result{}, nil
}

// specHashAnnotation is the annotation key on SandboxTemplate that stores
// a SHA-256 hash of the desired PodTemplate spec. Used to detect real spec
// changes without relying on reflect.DeepEqual (which fails because the K8s
// API server adds default fields like terminationGracePeriodSeconds, dnsPolicy,
// etc. that our buildPodTemplate does not set).
const specHashAnnotation = "runtime.agent-sandbox.io/spec-hash"

// computeSpecHash returns a short hex SHA-256 digest of the desired PodTemplate.
// We serialize to JSON first so the hash is deterministic.
func computeSpecHash(pt sandboxv1alpha1.PodTemplate) string {
	data, _ := json.Marshal(pt)
	sum := sha256.Sum256(data)
	return fmt.Sprintf("%x", sum[:16]) // 32-char hex
}

// ensureSandboxTemplate creates or updates the SandboxTemplate for this CodeInterpreter.
//
// To avoid reconcile storms (the K8s API server adds default fields to PodSpec that make
// reflect.DeepEqual always return false), we compute a SHA-256 hash of our desired spec
// and store it as an annotation. The template is only updated when the hash changes.
func (r *CodeInterpreterReconciler) ensureSandboxTemplate(ctx context.Context, ci *runtimev1alpha1.CodeInterpreter) error {
	desired := r.buildPodTemplate(ci)
	desiredHash := computeSpecHash(desired)

	existing := &extensionsv1alpha1.SandboxTemplate{}
	err := r.Get(ctx, types.NamespacedName{Name: ci.Name, Namespace: ci.Namespace}, existing)

	if errors.IsNotFound(err) {
		tmpl := &extensionsv1alpha1.SandboxTemplate{
			ObjectMeta: metav1.ObjectMeta{
				Name:      ci.Name,
				Namespace: ci.Namespace,
				Annotations: map[string]string{
					specHashAnnotation: desiredHash,
				},
			},
			Spec: extensionsv1alpha1.SandboxTemplateSpec{
				PodTemplate: desired,
			},
		}
		if err := controllerutil.SetControllerReference(ci, tmpl, r.Scheme); err != nil {
			return fmt.Errorf("set owner reference: %w", err)
		}
		if err := r.Create(ctx, tmpl); err != nil && !errors.IsAlreadyExists(err) {
			return fmt.Errorf("create SandboxTemplate: %w", err)
		}
		return nil
	}
	if err != nil {
		return fmt.Errorf("get SandboxTemplate: %w", err)
	}

	// Compare hashes: only update if the desired spec actually changed.
	existingHash := ""
	if existing.Annotations != nil {
		existingHash = existing.Annotations[specHashAnnotation]
	}

	if existingHash == desiredHash {
		return nil // spec unchanged — no-op
	}

	// Spec changed — update the SandboxTemplate and trigger WarmPool rebuild.
	if existing.Annotations == nil {
		existing.Annotations = make(map[string]string)
	}
	existing.Annotations[specHashAnnotation] = desiredHash
	existing.Spec.PodTemplate = desired
	if err := r.Update(ctx, existing); err != nil {
		return fmt.Errorf("update SandboxTemplate: %w", err)
	}
	// Template spec changed: delete the SandboxWarmPool so K8s cascades the deletion
	// to the owned Sandbox objects (and their Pods). Our reconciler will immediately
	// recreate the SandboxWarmPool in ensureSandboxWarmPool, causing the WarmPool
	// Controller to spin up fresh Pods from the updated template.
	if err := r.triggerWarmPoolRebuild(ctx, ci); err != nil {
		return fmt.Errorf("trigger WarmPool rebuild after template update: %w", err)
	}
	return nil
}

// triggerWarmPoolRebuild deletes the SandboxWarmPool owned by this CodeInterpreter.
// K8s OwnerReference cascades the deletion to all Sandbox objects (and their Pods) owned
// by the WarmPool. ensureSandboxWarmPool will recreate it in the same reconcile cycle,
// causing the WarmPool Controller to provision fresh Pods from the updated template.
//
// This ensures that a `kubectl apply` (or PUT /v1/templates) on a CodeInterpreter always
// results in all WarmPool Pods being replaced with the new spec — no manual Pod deletion needed.
func (r *CodeInterpreterReconciler) triggerWarmPoolRebuild(ctx context.Context, ci *runtimev1alpha1.CodeInterpreter) error {
	logger := log.FromContext(ctx)

	if ci.Spec.WarmPoolSize == nil || *ci.Spec.WarmPoolSize == 0 {
		return nil // no WarmPool configured — nothing to rebuild
	}

	wp := &extensionsv1alpha1.SandboxWarmPool{}
	err := r.Get(ctx, types.NamespacedName{Name: ci.Name, Namespace: ci.Namespace}, wp)
	if errors.IsNotFound(err) {
		return nil // WarmPool doesn't exist yet — will be created normally
	}
	if err != nil {
		return fmt.Errorf("get SandboxWarmPool for rebuild: %w", err)
	}

	logger.Info("template spec changed: triggering WarmPool rebuild",
		"name", ci.Name, "namespace", ci.Namespace,
		"warmPoolSize", *ci.Spec.WarmPoolSize)

	if err := r.Delete(ctx, wp); err != nil && !errors.IsNotFound(err) {
		return fmt.Errorf("delete SandboxWarmPool for rebuild: %w", err)
	}
	return nil
}

// ensureSandboxWarmPool creates or updates the SandboxWarmPool for this CodeInterpreter.
func (r *CodeInterpreterReconciler) ensureSandboxWarmPool(ctx context.Context, ci *runtimev1alpha1.CodeInterpreter) error {
	replicas := *ci.Spec.WarmPoolSize

	existing := &extensionsv1alpha1.SandboxWarmPool{}
	err := r.Get(ctx, types.NamespacedName{Name: ci.Name, Namespace: ci.Namespace}, existing)

	if errors.IsNotFound(err) {
		wp := &extensionsv1alpha1.SandboxWarmPool{
			ObjectMeta: metav1.ObjectMeta{
				Name:      ci.Name,
				Namespace: ci.Namespace,
			},
			Spec: extensionsv1alpha1.SandboxWarmPoolSpec{
				Replicas: replicas,
				TemplateRef: extensionsv1alpha1.SandboxTemplateRef{
					Name: ci.Name,
				},
			},
		}
		if err := controllerutil.SetControllerReference(ci, wp, r.Scheme); err != nil {
			return fmt.Errorf("set owner reference: %w", err)
		}
		if err := r.Create(ctx, wp); err != nil && !errors.IsAlreadyExists(err) {
			return fmt.Errorf("create SandboxWarmPool: %w", err)
		}
		return nil
	}
	if err != nil {
		return fmt.Errorf("get SandboxWarmPool: %w", err)
	}

	// Update replicas if changed
	if existing.Spec.Replicas != replicas {
		existing.Spec.Replicas = replicas
		if err := r.Update(ctx, existing); err != nil {
			return fmt.Errorf("update SandboxWarmPool: %w", err)
		}
	}
	return nil
}

func (r *CodeInterpreterReconciler) deleteSandboxWarmPool(ctx context.Context, ci *runtimev1alpha1.CodeInterpreter) error {
	wp := &extensionsv1alpha1.SandboxWarmPool{}
	err := r.Get(ctx, types.NamespacedName{Name: ci.Name, Namespace: ci.Namespace}, wp)
	if errors.IsNotFound(err) {
		return nil
	}
	if err != nil {
		return err
	}
	return r.Delete(ctx, wp)
}

// envdInjectorImage returns the EnvD injector image from ENVD_INJECTOR_IMAGE.
// Used by runc pods (initContainer injection).
//
// The fallback is a moving tag, which is deliberate only as a development
// convenience: no versioned release of this image has been published, so there
// is no fixed tag to point at. Every deployment manifest in deploy/ sets
// ENVD_INJECTOR_IMAGE explicitly, and any real deployment should do the same.
func envdInjectorImage() string {
	if img := os.Getenv("ENVD_INJECTOR_IMAGE"); img != "" {
		return img
	}
	return "primussafe/agent-sandbox-envd-injector:latest"
}

// buildStartupScript builds the container startup command from steps + exec envd.
// The initContainer copies envd and tmux to /shared/bin/ before the main container starts.
//
// Example output:
//
//	export PATH=/shared/bin:$PATH && mkdir -p /home/sandbox && pip install numpy -q && exec /shared/bin/envd --port=8080 --workspace=/home/sandbox
func buildStartupScript(steps []runtimev1alpha1.SandboxBuildStep, workspace string) string {
	var parts []string
	// Add /shared/bin to PATH so EnvD can find tmux (injected by initContainer).
	parts = append(parts, "export PATH=/shared/bin:$PATH")
	// Create workspace directory — it may not exist in the base image.
	// We intentionally do NOT cd into it: the container keeps the image's default
	// WORKDIR, which may be meaningful for custom images. EnvD's --workspace flag
	// controls the file operation root for API users.
	parts = append(parts, fmt.Sprintf("mkdir -p %s", workspace))
	for _, step := range steps {
		if step.Type == "run" && len(step.Args) > 0 {
			parts = append(parts, step.Args[0])
		}
	}
	execCmd := fmt.Sprintf("exec /shared/bin/envd --port=8080 --workspace=%s", workspace)
	parts = append(parts, execCmd)
	return strings.Join(parts, " && ")
}

// codeInterpreterVolumeMountToCore maps template volume mounts to core VolumeMounts.
// When readOnly is omitted (nil), defaults to read-only; writable mounts must set readOnly explicitly to false.
// Memory-backed emptyDir volumes are always mounted read-write.
func codeInterpreterVolumeMountToCore(vm runtimev1alpha1.CodeInterpreterVolumeMount, isMemoryEmptyDir bool) corev1.VolumeMount {
	out := corev1.VolumeMount{
		Name:      vm.Name,
		MountPath: vm.MountPath,
		SubPath:   vm.SubPath,
	}
	if isMemoryEmptyDir {
		out.ReadOnly = false
		return out
	}
	if vm.ReadOnly == nil {
		out.ReadOnly = true
	} else {
		out.ReadOnly = *vm.ReadOnly
	}
	return out
}

// buildPodTemplate converts CodeInterpreterSpec into a sandboxv1alpha1.PodTemplate.
//
// EnvD is injected via initContainer: the envd-injector image copies the envd
// binary to a shared emptyDir volume, which the main container then uses.
// The user's fromImage is used as-is — no image modification needed.
//
// WorkingDir is intentionally NOT set on the container to avoid kata-qemu ENOENT
// errors when the workspace path doesn't exist in the base image.
func (r *CodeInterpreterReconciler) buildPodTemplate(ci *runtimev1alpha1.CodeInterpreter) sandboxv1alpha1.PodTemplate {
	tmpl := ci.Spec.Template
	workspace := "/home/sandbox"

	// Normalize RuntimeClassName
	runtimeClass := tmpl.RuntimeClassName
	if runtimeClass != nil && *runtimeClass == "" {
		runtimeClass = nil
	}

	// ── Build env vars ────────────────────────────────────────────────────────
	// Start with template-level environment vars
	envVars := make([]corev1.EnvVar, len(tmpl.Environment))
	copy(envVars, tmpl.Environment)

	// Apply ENV steps (format: "KEY=VALUE")
	for _, step := range tmpl.Steps {
		if step.Type == "env" && len(step.Args) > 0 {
			kv := step.Args[0]
			idx := strings.Index(kv, "=")
			if idx > 0 {
				envVars = append(envVars, corev1.EnvVar{
					Name:  kv[:idx],
					Value: kv[idx+1:],
				})
			}
		}
	}

	// Inject PATH that includes /shared/bin (for envd, tmux injected by initContainer).
	// This is always prepended so envd and tmux are discoverable regardless of
	// the base image's default PATH or user's env steps.
	// If the user also sets PATH via env step, their value is already in envVars
	// above; we prepend /shared/bin to ensure injected tools are always found.
	envVars = append(envVars, corev1.EnvVar{
		Name:  "PATH",
		Value: "/shared/bin:/home/sandbox/.local/bin:/usr/local/bin:/usr/bin:/bin:/sbin",
	})

	// Inject Router public key for EnvD JWT validation (authMode=envd, default)
	if ci.Spec.AuthMode != runtimev1alpha1.AuthModeNone {
		if pubKey := GetCachedPublicKey(); pubKey != "" {
			envVars = append(envVars, corev1.EnvVar{
				Name:  "ENVD_AUTH_PUBLIC_KEY",
				Value: pubKey,
			})
		}
	}

	// Inject egress proxy env vars.
	if egressEnabled() {
		envVars = append(envVars, corev1.EnvVar{
			Name:  "EGRESS_ENABLED",
			Value: "true",
		})
		if extra := egressExtraBlockedCIDRs(); extra != "" {
			envVars = append(envVars, corev1.EnvVar{
				Name:  "EGRESS_EXTRA_BLOCKED_CIDRS",
				Value: extra,
			})
		}
	}

	// Inject unified inference gateway env vars.
	// Only OPENAI_BASE_URL (LiteLLM address) is injected via Pod env — it's global and same for all sandboxes.
	// OPENAI_API_KEY is per-user and injected by EnvD at process level (from Redis session data).
	if inferenceEnabled() {
		if endpoint := inferenceLiteLLMEndpoint(); endpoint != "" {
			envVars = append(envVars, corev1.EnvVar{
				Name:  "OPENAI_BASE_URL",
				Value: endpoint,
			})
		}
	}

	// EnvD needs WM URL for both inference key fetch and egress policy sync.
	// Authentication uses Router-signed JWT (captured from incoming request),
	// so no static token injection is needed.
	if inferenceEnabled() || egressEnabled() {
		wmURL := fmt.Sprintf("http://%s.%s.svc.cluster.local:%s",
			workloadManagerServiceName(),
			os.Getenv("AGENT_SANDBOX_NAMESPACE"),
			workloadManagerServicePort(),
		)
		envVars = append(envVars, corev1.EnvVar{
			Name:  "WORKLOAD_MANAGER_URL",
			Value: wmURL,
		})
	}

	// Apply WORKDIR step (last one wins)
	for _, step := range tmpl.Steps {
		if step.Type == "workdir" && len(step.Args) > 0 {
			workspace = step.Args[0]
		}
	}

	// ── Build resource requirements ───────────────────────────────────────────
	resources := tmpl.Resources.DeepCopy()
	if ci.Spec.GPU != nil {
		gpu := ci.Spec.GPU
		if resources.Limits == nil {
			resources.Limits = corev1.ResourceList{}
		}
		if resources.Requests == nil {
			resources.Requests = corev1.ResourceList{}
		}
		resName := corev1.ResourceName(gpu.ResourceName)
		if resName == "" {
			resName = "amd.com/gpu"
		}
		count := resource.MustParse(fmt.Sprintf("%d", gpu.Count))
		resources.Limits[resName] = count
		resources.Requests[resName] = count
	}

	// ── Volumes ───────────────────────────────────────────────────────────────
	// envd-bin: shared emptyDir for EnvD binary injection
	volumes := []corev1.Volume{
		{
			Name: "envd-bin",
			VolumeSource: corev1.VolumeSource{
				EmptyDir: &corev1.EmptyDirVolumeSource{},
			},
		},
	}
	if ci.Spec.AuthMode != runtimev1alpha1.AuthModeNone {
		volumes = append(volumes, corev1.Volume{
			Name: "envd-session-identity",
			VolumeSource: corev1.VolumeSource{
				DownwardAPI: &corev1.DownwardAPIVolumeSource{
					Items: []corev1.DownwardAPIVolumeFile{
						{
							Path: "session-id",
							FieldRef: &corev1.ObjectFieldSelector{
								FieldPath: "metadata.annotations['runtime.agent-sandbox.io/session-id']",
							},
						},
					},
				},
			},
		})
	}

	// GPU /dev/shm volume
	if ci.Spec.GPU != nil && ci.Spec.GPU.SharedMemory != "" {
		shmSize := resource.MustParse(ci.Spec.GPU.SharedMemory)
		volumes = append(volumes, corev1.Volume{
			Name: "dshm",
			VolumeSource: corev1.VolumeSource{
				EmptyDir: &corev1.EmptyDirVolumeSource{
					Medium:    corev1.StorageMediumMemory,
					SizeLimit: &shmSize,
				},
			},
		})
	}

	// User-defined volumes from template (e.g. hostPath, NFS, PVC)
	volumes = append(volumes, tmpl.Volumes...)

	// ── EnvD injection via initContainer ─────────────────────────────────────
	//
	// The envd-injector initContainer copies the envd binary from its image
	// to a shared emptyDir volume (/shared/bin/envd). The main container
	// then executes envd from that shared path.
	//
	// This works for both runc AND kata-qemu:
	//   - runc: initContainer runs first, main container starts after
	//   - kata-qemu: same — initContainer completes before main container
	//
	// The user's fromImage is used as-is — no image modification needed.
	startupScript := buildStartupScript(tmpl.Steps, workspace)

	mainVolumeMounts := []corev1.VolumeMount{
		{Name: "envd-bin", MountPath: "/shared/bin"},
	}
	if ci.Spec.AuthMode != runtimev1alpha1.AuthModeNone {
		mainVolumeMounts = append(mainVolumeMounts, corev1.VolumeMount{
			Name:      "envd-session-identity",
			MountPath: "/var/run/agent-sandbox/session",
			ReadOnly:  true,
		})
	}
	if ci.Spec.GPU != nil && ci.Spec.GPU.SharedMemory != "" {
		mainVolumeMounts = append(mainVolumeMounts, corev1.VolumeMount{
			Name:      "dshm",
			MountPath: "/dev/shm",
		})
	}

	// User-defined mounts: omit readOnly → read-only by default; explicit readOnly:false → writable.
	// Memory-backed emptyDir is forced RW regardless (shared-memory semantics).
	for _, vm := range tmpl.VolumeMounts {
		isMemoryEmptyDir := false
		for _, v := range tmpl.Volumes {
			if v.Name == vm.Name && v.EmptyDir != nil && v.EmptyDir.Medium == corev1.StorageMediumMemory {
				isMemoryEmptyDir = true
				break
			}
		}

		mainVolumeMounts = append(mainVolumeMounts, codeInterpreterVolumeMountToCore(vm, isMemoryEmptyDir))
	}

	envdInjectorContainer := corev1.Container{
		Name:            "envd-injector",
		Image:           envdInjectorImage(),
		ImagePullPolicy: corev1.PullIfNotPresent,
		// Copy envd, tmux, iptables, and musl dynamic linker to shared volume.
		// iptables is dynamically linked to musl; patchelf sets its interpreter to
		// /shared/bin/ld-musl-x86_64.so.1 so it works in any glibc-based user image.
		// iptables is copied twice (as iptables + ip6tables) because xtables-legacy-multi
		// uses argv[0] to determine the protocol family.
		Command: []string{"sh", "-c", "cp /envd /shared/bin/envd && (cp /tmux /shared/bin/tmux 2>/dev/null || true) && (cp /iptables /shared/bin/iptables && cp /iptables /shared/bin/ip6tables && ln -sf iptables /shared/bin/iptables-legacy && ln -sf ip6tables /shared/bin/ip6tables-legacy && cp /musl-ld.so /shared/bin/ld-musl-x86_64.so.1 && ln -sf ld-musl-x86_64.so.1 /shared/bin/libc.musl-x86_64.so.1 2>/dev/null || true)"},
		VolumeMounts: []corev1.VolumeMount{
			{Name: "envd-bin", MountPath: "/shared/bin"},
		},
	}

	// ── Main container ────────────────────────────────────────────────────────
	//
	// WorkingDir is intentionally NOT set. kata-qemu validates that WorkingDir
	// exists in the image BEFORE running the container command — if the path
	// (e.g. /home/sandbox) doesn't exist in the base image, kata fails with
	// ENOENT. Leaving it empty lets the image's default WORKDIR take effect.
	//
	// The actual workspace is handled by the startup script:
	//   mkdir -p <workspace> && ... && exec /shared/bin/envd --workspace=<workspace>
	var secCtx *corev1.SecurityContext
	if egressEnabled() {
		// Egress transparent proxy requires CAP_NET_ADMIN + CAP_NET_RAW for iptables REDIRECT.
		// Works in both runc and kata-qemu. If Pod Security Admission blocks it,
		// the namespace needs "privileged" or "baseline" Pod Security Standard.
		secCtx = &corev1.SecurityContext{
			Capabilities: &corev1.Capabilities{
				Add: []corev1.Capability{"NET_ADMIN", "NET_RAW"},
			},
		}
	}

	mainContainer := corev1.Container{
		Name:            "codeinterpreter",
		Image:           tmpl.FromImage,
		ImagePullPolicy: tmpl.ImagePullPolicy,
		Command:         []string{"/bin/sh", "-c"},
		Args:            []string{startupScript},
		Env:             envVars,
		Resources:       *resources,
		VolumeMounts:    mainVolumeMounts,
		SecurityContext: secCtx,
		// ReadinessProbe: EnvD serves /health on port 8080.
		// Pod Ready=true ONLY after EnvD is actually responding — this means
		// ALL run steps have completed successfully (they execute before exec envd).
		// Without this probe, K8s marks the container Ready as soon as it starts,
		// even while pip install is still running, leading to false "ready" state.
		ReadinessProbe: &corev1.Probe{
			ProbeHandler: corev1.ProbeHandler{
				HTTPGet: &corev1.HTTPGetAction{
					Path: "/health",
					Port: intstr.FromInt(8080),
				},
			},
			InitialDelaySeconds: 1,
			PeriodSeconds:       2,
			TimeoutSeconds:      2,
			SuccessThreshold:    1,
			FailureThreshold:    30, // Pod stays NotReady during build steps; probe continues indefinitely until envd responds
		},
	}

	// ── All containers: main + user sidecars ─────────────────────────────────
	var containers []corev1.Container
	containers = append(containers, mainContainer)
	containers = append(containers, tmpl.Sidecars...)

	podSpec := corev1.PodSpec{
		InitContainers:   []corev1.Container{envdInjectorContainer},
		Containers:       containers,
		ImagePullSecrets: tmpl.ImagePullSecrets,
		RuntimeClassName: runtimeClass,
		Volumes:          volumes,
		RestartPolicy:    corev1.RestartPolicyNever,
		// Restrict Sandbox Pods to worker nodes (configured via SANDBOX_NODE_SELECTOR env var)
		NodeSelector: sandboxNodeSelector(),
		Tolerations:  sandboxTolerations(),
	}

	podMeta := sandboxv1alpha1.PodMetadata{}
	if tmpl.Labels != nil {
		podMeta.Labels = tmpl.Labels
	}
	if tmpl.Annotations != nil {
		podMeta.Annotations = tmpl.Annotations
	}

	return sandboxv1alpha1.PodTemplate{
		Spec:       podSpec,
		ObjectMeta: podMeta,
	}
}

// updateReadyStatus marks the CodeInterpreter as Ready.
//
// We re-fetch the latest CI from the API server before updating status so that
// we never hit "the object has been modified" conflicts caused by earlier
// annotation patches (ensureCombinedImage) or owned-resource mutations in
// the same reconcile cycle.
func (r *CodeInterpreterReconciler) updateReadyStatus(ctx context.Context, ci *runtimev1alpha1.CodeInterpreter) error {
	// Re-fetch the latest version to avoid resourceVersion conflicts.
	latest := &runtimev1alpha1.CodeInterpreter{}
	if err := r.Get(ctx, types.NamespacedName{Name: ci.Name, Namespace: ci.Namespace}, latest); err != nil {
		return fmt.Errorf("re-fetch CodeInterpreter for status update: %w", err)
	}

	latest.Status.Ready = true
	now := metav1.Now()

	readyCond := metav1.Condition{
		Type:               "Ready",
		Status:             metav1.ConditionTrue,
		Reason:             "Reconciled",
		Message:            "SandboxTemplate is in sync",
		LastTransitionTime: now,
		ObservedGeneration: latest.Generation,
	}

	found := false
	for i, c := range latest.Status.Conditions {
		if c.Type == "Ready" {
			latest.Status.Conditions[i] = readyCond
			found = true
			break
		}
	}
	if !found {
		latest.Status.Conditions = append(latest.Status.Conditions, readyCond)
	}

	return r.Status().Update(ctx, latest)
}

// sandboxNodeSelector returns the nodeSelector for Sandbox Pods.
// Reads SANDBOX_NODE_SELECTOR env var, format: "key=value,key2=value2"
// Example: SANDBOX_NODE_SELECTOR=agent-sandbox.io/node-pool=workers
// If not set, returns nil (pods can run on any node).
func sandboxNodeSelector() map[string]string {
	val := os.Getenv("SANDBOX_NODE_SELECTOR")
	if val == "" {
		return nil
	}
	selector := make(map[string]string)
	for _, pair := range strings.Split(val, ",") {
		pair = strings.TrimSpace(pair)
		if idx := strings.Index(pair, "="); idx > 0 {
			selector[pair[:idx]] = pair[idx+1:]
		}
	}
	return selector
}

// sandboxTolerations returns tolerations for Sandbox Pods.
// Reads SANDBOX_TOLERATIONS env var.
//
// Supported formats:
//   - "*"                    → tolerate ALL taints (operator: Exists)
//   - "key1,key2"           → tolerate specific keys with all effects
//   - "key1=val:NoSchedule" → tolerate specific key=value with effect
//   - "key1:NoSchedule"     → tolerate specific key with effect (no value)
//
// Multiple entries separated by commas.
// If not set, returns nil (default K8s scheduling behavior).
func sandboxTolerations() []corev1.Toleration {
	val := os.Getenv("SANDBOX_TOLERATIONS")
	if val == "" {
		return nil
	}
	val = strings.TrimSpace(val)
	if val == "*" {
		return []corev1.Toleration{{Operator: corev1.TolerationOpExists}}
	}

	var tolerations []corev1.Toleration
	for _, entry := range strings.Split(val, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		t := corev1.Toleration{Operator: corev1.TolerationOpExists}

		// Split off ":Effect" suffix (e.g. "key:NoSchedule" or "key=val:NoSchedule")
		if colonIdx := strings.LastIndex(entry, ":"); colonIdx > 0 {
			t.Effect = corev1.TaintEffect(entry[colonIdx+1:])
			entry = entry[:colonIdx]
		}

		// Parse "key=value" or just "key"
		if eqIdx := strings.Index(entry, "="); eqIdx > 0 {
			t.Key = entry[:eqIdx]
			t.Value = entry[eqIdx+1:]
			t.Operator = corev1.TolerationOpEqual
		} else {
			t.Key = entry
		}

		tolerations = append(tolerations, t)
	}
	return tolerations
}

// egressEnabled returns true when egress proxy is configured.
func egressEnabled() bool {
	return os.Getenv("EGRESS_ENABLED") == "true"
}

// egressExtraBlockedCIDRs returns comma-separated extra CIDRs to block.
func egressExtraBlockedCIDRs() string {
	return os.Getenv("EGRESS_EXTRA_BLOCKED_CIDRS")
}

// inferenceEnabled returns true when the unified inference gateway is configured.
// Reads INFERENCE_ENABLED env var set on the Workload Manager Deployment.
func inferenceEnabled() bool {
	return os.Getenv("INFERENCE_ENABLED") == "true"
}

// inferenceLiteLLMEndpoint returns the LiteLLM gateway URL
// (e.g. http://litellm.agent-sandbox-system:4000/v1).
func inferenceLiteLLMEndpoint() string {
	return os.Getenv("INFERENCE_LITELLM_ENDPOINT")
}

// workloadManagerServiceName returns the Service DNS name used by EnvD to reach
// the internal WM/controlplane API.
func workloadManagerServiceName() string {
	if name := os.Getenv("WORKLOAD_MANAGER_SERVICE_NAME"); name != "" {
		return name
	}
	return "workloadmanager"
}

// workloadManagerServicePort returns the Service port used by EnvD to reach WM.
func workloadManagerServicePort() string {
	if port := os.Getenv("WORKLOAD_MANAGER_SERVICE_PORT"); port != "" {
		return port
	}
	return "8080"
}

// SetupWithManager registers the controller.
func (r *CodeInterpreterReconciler) SetupWithManager(mgr ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(mgr).
		Named("codeinterpreter-controller").
		For(&runtimev1alpha1.CodeInterpreter{}).
		Owns(&extensionsv1alpha1.SandboxTemplate{}).
		Owns(&extensionsv1alpha1.SandboxWarmPool{}).
		Complete(r)
}
