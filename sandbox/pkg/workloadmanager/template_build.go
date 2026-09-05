// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"bufio"
	"context"
	"fmt"
	"hash/fnv"
	"io"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	extensionsv1alpha1 "sigs.k8s.io/agent-sandbox/extensions/api/v1alpha1"

	log "sigs.k8s.io/agent-sandbox/pkg/logx"
)

// BuildPhase represents a single phase in the template build process.
type BuildPhase struct {
	Phase    string  `json:"phase"`
	Status   string  `json:"status"`             // "started", "completed", "failed"
	Duration float64 `json:"duration,omitempty"` // seconds
	Message  string  `json:"message,omitempty"`
	ExitCode *int    `json:"exit_code,omitempty"`
	Stdout   string  `json:"stdout,omitempty"`
	Stderr   string  `json:"stderr,omitempty"`
}

// TemplateBuildResult is the result of watching a template build.
type TemplateBuildResult struct {
	BuildStatus   string       `json:"build_status"`             // "ready" or "failed"
	BuildDuration float64      `json:"build_duration,omitempty"` // total seconds
	BuildLog      []BuildPhase `json:"build_log"`
}

// BuildEvent is emitted during SSE streaming of a template build.
type BuildEvent struct {
	EventType string // "phase", "log", "end"
	Data      interface{}
}

// WatchTemplateBuild watches the first WarmPool Pod lifecycle after template creation.
// Returns a TemplateBuildResult with per-phase build log.
// Only meaningful when warmPoolSize > 0.
func (c *K8sSandboxCreator) WatchTemplateBuild(ctx context.Context, namespace, templateName string, timeout time.Duration) (*TemplateBuildResult, error) {
	buildStart := time.Now()
	var buildLog []BuildPhase

	// Phase 1: Wait for WarmPool Pod to appear
	phaseStart := time.Now()
	pod, err := c.waitForWarmPoolPod(ctx, namespace, templateName, timeout)
	if err != nil {
		buildLog = append(buildLog, BuildPhase{
			Phase:    "scheduling",
			Status:   "failed",
			Duration: time.Since(phaseStart).Seconds(),
			Message:  err.Error(),
		})
		return &TemplateBuildResult{
			BuildStatus:   "failed",
			BuildDuration: time.Since(buildStart).Seconds(),
			BuildLog:      buildLog,
		}, fmt.Errorf("template build failed: %w", err)
	}
	buildLog = append(buildLog, BuildPhase{
		Phase:    "scheduling",
		Status:   "completed",
		Duration: time.Since(phaseStart).Seconds(),
		Message:  fmt.Sprintf("Pod %s scheduled", pod.Name),
	})

	// Phase 2: Poll the FIRST Pod's status until Ready or Failed.
	// We track this specific Pod by name — if the WarmPool controller deletes it
	// and creates a replacement, we detect the disappearance and return failure immediately
	// (no need to wait for the second Pod to also fail).
	pollCtx, cancel := context.WithTimeout(ctx, timeout-time.Since(buildStart))
	defer cancel()

	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	trackedPodName := pod.Name // lock onto the first Pod
	lastPhase := ""
	phaseStart = time.Now()

	for {
		select {
		case <-ticker.C:
			// Re-fetch the specific tracked Pod by name
			trackedPod := &corev1.Pod{}
			if err := c.client.Get(pollCtx, ctrlclient.ObjectKey{
				Name: trackedPodName, Namespace: namespace,
			}, trackedPod); err != nil {
				// Pod disappeared — it was deleted after failure (WarmPool controller replaced it)
				buildLog = append(buildLog, BuildPhase{
					Phase:    lastPhase,
					Status:   "failed",
					Duration: time.Since(phaseStart).Seconds(),
					Message:  fmt.Sprintf("Pod %s disappeared (crashed and was replaced by WarmPool controller)", trackedPodName),
				})
				return &TemplateBuildResult{
					BuildStatus:   "failed",
					BuildDuration: time.Since(buildStart).Seconds(),
					BuildLog:      buildLog,
				}, fmt.Errorf("template build failed: Pod %s crashed and was replaced", trackedPodName)
			}
			pod = trackedPod

			currentPhase := detectPodBuildPhase(pod)

			if currentPhase != lastPhase {
				// Close previous phase
				if lastPhase != "" {
					buildLog = append(buildLog, BuildPhase{
						Phase:    lastPhase,
						Status:   "completed",
						Duration: time.Since(phaseStart).Seconds(),
					})
				}
				phaseStart = time.Now()
				lastPhase = currentPhase
			}

			// Check terminal states
			if isPodBuildReady(pod) {
				// Fetch container logs
				stdout, stderr := c.fetchContainerLogs(pollCtx, pod.Name, namespace)
				if lastPhase != "" {
					buildLog = append(buildLog, BuildPhase{
						Phase:    lastPhase,
						Status:   "completed",
						Duration: time.Since(phaseStart).Seconds(),
						Stdout:   stdout,
						Stderr:   stderr,
					})
				}
				buildLog = append(buildLog, BuildPhase{
					Phase:   "ready",
					Status:  "completed",
					Message: "EnvD started, sandbox ready",
				})
				return &TemplateBuildResult{
					BuildStatus:   "ready",
					BuildDuration: time.Since(buildStart).Seconds(),
					BuildLog:      buildLog,
				}, nil
			}

			if failed, reason := isPodBuildFailed(pod); failed {
				stdout, stderr := c.fetchContainerLogs(pollCtx, pod.Name, namespace)
				exitCode := getExitCode(pod)
				buildLog = append(buildLog, BuildPhase{
					Phase:    lastPhase,
					Status:   "failed",
					Duration: time.Since(phaseStart).Seconds(),
					Message:  reason,
					ExitCode: exitCode,
					Stdout:   stdout,
					Stderr:   stderr,
				})
				return &TemplateBuildResult{
					BuildStatus:   "failed",
					BuildDuration: time.Since(buildStart).Seconds(),
					BuildLog:      buildLog,
				}, fmt.Errorf("template build failed: %s", reason)
			}

		case <-pollCtx.Done():
			buildLog = append(buildLog, BuildPhase{
				Phase:    lastPhase,
				Status:   "failed",
				Duration: time.Since(phaseStart).Seconds(),
				Message:  "timeout waiting for Pod to be ready",
			})
			return &TemplateBuildResult{
				BuildStatus:   "failed",
				BuildDuration: time.Since(buildStart).Seconds(),
				BuildLog:      buildLog,
			}, fmt.Errorf("template build timeout after %.0fs", time.Since(buildStart).Seconds())
		}
	}
}

// WatchTemplateBuildSSE watches the template build and sends events to the channel.
// The caller should read from eventCh and write SSE events to the HTTP response.
func (c *K8sSandboxCreator) WatchTemplateBuildSSE(ctx context.Context, namespace, templateName string, timeout time.Duration, eventCh chan<- BuildEvent) {
	defer close(eventCh)

	buildStart := time.Now()

	// Phase 1: Wait for WarmPool Pod
	eventCh <- BuildEvent{EventType: "phase", Data: BuildPhase{Phase: "scheduling", Status: "started"}}
	phaseStart := time.Now()

	pod, err := c.waitForWarmPoolPod(ctx, namespace, templateName, timeout)
	if err != nil {
		eventCh <- BuildEvent{EventType: "phase", Data: BuildPhase{Phase: "scheduling", Status: "failed", Duration: time.Since(phaseStart).Seconds(), Message: err.Error()}}
		eventCh <- BuildEvent{EventType: "end", Data: map[string]interface{}{"build_status": "failed", "total_duration": time.Since(buildStart).Seconds()}}
		return
	}
	eventCh <- BuildEvent{EventType: "phase", Data: BuildPhase{Phase: "scheduling", Status: "completed", Duration: time.Since(phaseStart).Seconds(), Message: fmt.Sprintf("Pod %s scheduled", pod.Name)}}

	// Phase 2: Poll the FIRST Pod's status — track by name, stop on first failure.
	pollCtx, cancel := context.WithTimeout(ctx, timeout-time.Since(buildStart))
	defer cancel()

	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	trackedPodName := pod.Name
	lastPhase := ""
	phaseStart = time.Now()
	var logCancel context.CancelFunc

	for {
		select {
		case <-ticker.C:
			trackedPod := &corev1.Pod{}
			if err := c.client.Get(pollCtx, ctrlclient.ObjectKey{
				Name: trackedPodName, Namespace: namespace,
			}, trackedPod); err != nil {
				// Pod disappeared — deleted after failure
				if logCancel != nil {
					logCancel()
				}
				eventCh <- BuildEvent{EventType: "phase", Data: BuildPhase{Phase: lastPhase, Status: "failed", Duration: time.Since(phaseStart).Seconds(), Message: fmt.Sprintf("Pod %s crashed and was replaced", trackedPodName)}}
				eventCh <- BuildEvent{EventType: "end", Data: map[string]interface{}{"build_status": "failed", "error": fmt.Sprintf("Pod %s crashed", trackedPodName), "total_duration": time.Since(buildStart).Seconds()}}
				return
			}
			pod = trackedPod

			currentPhase := detectPodBuildPhase(pod)

			if currentPhase != lastPhase {
				if lastPhase != "" {
					eventCh <- BuildEvent{EventType: "phase", Data: BuildPhase{Phase: lastPhase, Status: "completed", Duration: time.Since(phaseStart).Seconds()}}
				}
				phaseStart = time.Now()
				lastPhase = currentPhase
				eventCh <- BuildEvent{EventType: "phase", Data: BuildPhase{Phase: currentPhase, Status: "started"}}

				// Start log streaming when build_steps begins
				if currentPhase == "build_steps" && c.kubeClient != nil {
					logCtx, lc := context.WithCancel(pollCtx)
					logCancel = lc
					go c.streamContainerLogsToChannel(logCtx, pod.Name, namespace, eventCh)
				}
			}

			if isPodBuildReady(pod) {
				if logCancel != nil {
					logCancel()
				}
				eventCh <- BuildEvent{EventType: "phase", Data: BuildPhase{Phase: lastPhase, Status: "completed", Duration: time.Since(phaseStart).Seconds()}}
				eventCh <- BuildEvent{EventType: "phase", Data: BuildPhase{Phase: "ready", Status: "completed", Message: "EnvD started, sandbox ready"}}
				eventCh <- BuildEvent{EventType: "end", Data: map[string]interface{}{"build_status": "ready", "total_duration": time.Since(buildStart).Seconds()}}
				return
			}

			if failed, reason := isPodBuildFailed(pod); failed {
				if logCancel != nil {
					logCancel()
				}
				exitCode := getExitCode(pod)
				eventCh <- BuildEvent{EventType: "phase", Data: BuildPhase{Phase: lastPhase, Status: "failed", Duration: time.Since(phaseStart).Seconds(), Message: reason, ExitCode: exitCode}}
				eventCh <- BuildEvent{EventType: "end", Data: map[string]interface{}{"build_status": "failed", "error": reason, "total_duration": time.Since(buildStart).Seconds()}}
				return
			}

		case <-pollCtx.Done():
			if logCancel != nil {
				logCancel()
			}
			eventCh <- BuildEvent{EventType: "phase", Data: BuildPhase{Phase: lastPhase, Status: "failed", Message: "timeout"}}
			eventCh <- BuildEvent{EventType: "end", Data: map[string]interface{}{"build_status": "failed", "error": "timeout", "total_duration": time.Since(buildStart).Seconds()}}
			return
		}
	}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// waitForWarmPoolPod waits for the first WarmPool Pod to appear for the given template.
func (c *K8sSandboxCreator) waitForWarmPoolPod(ctx context.Context, namespace, templateName string, timeout time.Duration) (*corev1.Pod, error) {
	waitCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	poolHash := hashName(templateName)

	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			// First check WarmPool exists
			wp := &extensionsv1alpha1.SandboxWarmPool{}
			if err := c.client.Get(waitCtx, ctrlclient.ObjectKey{Name: templateName, Namespace: namespace}, wp); err != nil {
				continue // WarmPool not created yet by controller
			}

			// Look for pods with pool label
			podList := &corev1.PodList{}
			if err := c.client.List(waitCtx, podList,
				ctrlclient.InNamespace(namespace),
				ctrlclient.MatchingLabels{"agents.x-k8s.io/pool": poolHash},
			); err != nil {
				continue
			}
			if len(podList.Items) > 0 {
				return &podList.Items[0], nil
			}
		case <-waitCtx.Done():
			return nil, fmt.Errorf("timeout waiting for WarmPool pod to appear for template %s/%s", namespace, templateName)
		}
	}
}

// hashName computes the same FNV-1a hash as sandboxcontrollers.NameHash.
// Inlined here to avoid a circular import with the controllers package.
func hashName(name string) string {
	h := fnv.New32a()
	h.Write([]byte(name))
	return fmt.Sprintf("%08x", h.Sum32())
}

// detectPodBuildPhase determines the current build phase from Pod status.
func detectPodBuildPhase(pod *corev1.Pod) string {
	// Check init containers — any not-yet-completed init container means we're in envd_injection phase
	for _, cs := range pod.Status.InitContainerStatuses {
		if cs.State.Running != nil {
			return "envd_injection"
		}
		if cs.State.Waiting != nil {
			return "envd_injection"
		}
		// cs.State.Terminated with exit=0 → init done, check next
		if cs.State.Terminated != nil && cs.State.Terminated.ExitCode != 0 {
			return "envd_injection" // init failed
		}
	}

	// Check main container
	for _, cs := range pod.Status.ContainerStatuses {
		if cs.State.Waiting != nil {
			switch cs.State.Waiting.Reason {
			case "ContainerCreating":
				return "image_pull"
			case "PodInitializing":
				return "image_pull"
			case "ErrImagePull", "ImagePullBackOff", "InvalidImageName":
				return "image_pull"
			case "CrashLoopBackOff":
				return "build_steps" // container crashed after running
			}
			return "image_pull"
		}
		if cs.State.Running != nil {
			return "build_steps"
		}
		if cs.State.Terminated != nil {
			return "build_steps" // container ran and exited
		}
	}

	// Pod is still in Pending phase
	if pod.Status.Phase == corev1.PodPending {
		return "scheduling"
	}

	return "unknown"
}

// isPodBuildReady checks if the Pod is truly Running with all containers Ready.
// With the readiness probe on the main container (HTTP GET /health:8080),
// Ready=true means EnvD is responding — all run steps completed successfully.
func isPodBuildReady(pod *corev1.Pod) bool {
	if pod.Status.Phase != corev1.PodRunning {
		return false
	}
	if len(pod.Status.ContainerStatuses) == 0 {
		return false
	}
	for _, cs := range pod.Status.ContainerStatuses {
		if !cs.Ready {
			return false
		}
	}
	return true
}

// isPodBuildFailed checks if the Pod has entered a terminal failure state.
func isPodBuildFailed(pod *corev1.Pod) (bool, string) {
	if pod.Status.Phase == corev1.PodFailed {
		return true, fmt.Sprintf("pod phase: Failed (reason: %s)", pod.Status.Reason)
	}

	for _, cs := range pod.Status.InitContainerStatuses {
		if cs.State.Terminated != nil && cs.State.Terminated.ExitCode != 0 {
			return true, fmt.Sprintf("init-container %q exited with code %d", cs.Name, cs.State.Terminated.ExitCode)
		}
		if cs.State.Waiting != nil {
			switch cs.State.Waiting.Reason {
			case "ErrImagePull", "ImagePullBackOff", "InvalidImageName":
				return true, fmt.Sprintf("init-container %q: %s — %s", cs.Name, cs.State.Waiting.Reason, cs.State.Waiting.Message)
			}
		}
	}

	for _, cs := range pod.Status.ContainerStatuses {
		if cs.State.Terminated != nil && cs.State.Terminated.ExitCode != 0 {
			return true, fmt.Sprintf("container %q exited with code %d", cs.Name, cs.State.Terminated.ExitCode)
		}
		if cs.State.Waiting != nil {
			switch cs.State.Waiting.Reason {
			case "CrashLoopBackOff", "ErrImagePull", "ImagePullBackOff", "InvalidImageName", "CreateContainerConfigError":
				return true, fmt.Sprintf("container %q: %s — %s", cs.Name, cs.State.Waiting.Reason, cs.State.Waiting.Message)
			}
		}
	}

	return false, ""
}

// getExitCode extracts the exit code from the first failed container.
func getExitCode(pod *corev1.Pod) *int {
	for _, cs := range pod.Status.InitContainerStatuses {
		if cs.State.Terminated != nil && cs.State.Terminated.ExitCode != 0 {
			code := int(cs.State.Terminated.ExitCode)
			return &code
		}
	}
	for _, cs := range pod.Status.ContainerStatuses {
		if cs.State.Terminated != nil && cs.State.Terminated.ExitCode != 0 {
			code := int(cs.State.Terminated.ExitCode)
			return &code
		}
	}
	return nil
}

// fetchContainerLogs fetches the last 50 lines of container logs.
// Uses a fresh 10s context since the caller's context may be near expiry.
func (c *K8sSandboxCreator) fetchContainerLogs(ctx context.Context, podName, namespace string) (stdout, stderr string) {
	if c.kubeClient == nil {
		return "(logs unavailable: kubeClient not initialized)", ""
	}
	// Use a fresh context — the original ctx may be nearly expired
	logCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	tailLines := int64(50)
	logReq := c.kubeClient.CoreV1().Pods(namespace).GetLogs(podName, &corev1.PodLogOptions{
		Container: "codeinterpreter",
		TailLines: &tailLines,
	})
	logStream, err := logReq.Stream(logCtx)
	if err != nil {
		return fmt.Sprintf("(logs unavailable: %v)", err), ""
	}
	defer logStream.Close()
	logBytes, _ := io.ReadAll(logStream)
	logStr := strings.TrimSpace(string(logBytes))
	if logStr == "" {
		return "(container produced no output)", ""
	}
	return logStr, ""
}

// streamContainerLogsToChannel streams container logs to the BuildEvent channel.
func (c *K8sSandboxCreator) streamContainerLogsToChannel(ctx context.Context, podName, namespace string, eventCh chan<- BuildEvent) {
	if c.kubeClient == nil {
		return
	}
	logReq := c.kubeClient.CoreV1().Pods(namespace).GetLogs(podName, &corev1.PodLogOptions{
		Container: "codeinterpreter",
		Follow:    true,
	})
	logStream, err := logReq.Stream(ctx)
	if err != nil {
		log.Debug("Failed to stream container logs", "pod", podName, "error", err)
		return
	}
	defer logStream.Close()

	scanner := bufio.NewScanner(logStream)
	for scanner.Scan() {
		select {
		case <-ctx.Done():
			return
		case eventCh <- BuildEvent{EventType: "log", Data: map[string]string{"stdout": scanner.Text() + "\n"}}:
		}
	}
}
