// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"context"
	"fmt"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"

	log "sigs.k8s.io/agent-sandbox/pkg/logx"
	"sigs.k8s.io/agent-sandbox/pkg/store"
)

var (
	sandboxHealthGauge = promauto.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "sandbox_pod_health",
			Help: "Health status of sandbox pods (1=healthy, 0=unhealthy)",
		},
		[]string{"session_id", "pod", "namespace", "status"},
	)

	sandboxUnhealthyTotal = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "sandbox_unhealthy_pods_total",
			Help: "Total number of currently unhealthy sandbox pods",
		},
	)

	sandboxActiveTotal = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "sandbox_active_sessions_total",
			Help: "Total number of active sandbox sessions being monitored",
		},
	)

	sandboxWatchScanDuration = promauto.NewHistogram(
		prometheus.HistogramOpts{
			Name:    "sandbox_watch_scan_duration_seconds",
			Help:    "Duration of each sandbox health scan cycle",
			Buckets: []float64{0.1, 0.5, 1, 2, 5, 10},
		},
	)
)

// SandboxWatcherConfig holds watcher configuration.
type SandboxWatcherConfig struct {
	Interval  time.Duration
	Namespace string
}

// DefaultWatcherConfig returns sensible defaults.
func DefaultWatcherConfig() SandboxWatcherConfig {
	return SandboxWatcherConfig{
		Interval: 30 * time.Second,
	}
}

// SandboxWatcher periodically scans active sessions, checks Pod health,
// and exposes results as Prometheus metrics for external monitoring (e.g. Robust).
type SandboxWatcher struct {
	cfg   SandboxWatcherConfig
	store store.Store
	k8s   kubernetes.Interface

	mu        sync.Mutex
	unhealthy map[string]*podIssue
}

type podIssue struct {
	SessionID  string
	PodName    string
	Namespace  string
	Status     string
	Node       string
	Reason     string
	DetectedAt time.Time
}

// NewSandboxWatcher creates a watcher. Returns nil if k8s client is unavailable.
func NewSandboxWatcher(cfg SandboxWatcherConfig, st store.Store, k8s kubernetes.Interface) *SandboxWatcher {
	if k8s == nil || st == nil {
		return nil
	}
	return &SandboxWatcher{
		cfg:       cfg,
		store:     st,
		k8s:       k8s,
		unhealthy: make(map[string]*podIssue),
	}
}

// Run starts the periodic scan loop. Blocks until ctx is cancelled.
func (w *SandboxWatcher) Run(ctx context.Context) {
	log.Info("sandbox-watcher: started", "interval", w.cfg.Interval)
	ticker := time.NewTicker(w.cfg.Interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Info("sandbox-watcher: stopped")
			return
		case <-ticker.C:
			w.scan(ctx)
		}
	}
}

func (w *SandboxWatcher) scan(ctx context.Context) {
	start := time.Now()
	defer func() {
		sandboxWatchScanDuration.Observe(time.Since(start).Seconds())
	}()

	sessions, err := w.store.ListAllSandboxes(ctx, 10000)
	if err != nil {
		log.Warn("sandbox-watcher: failed to list sessions", "error", err)
		return
	}

	active := 0
	nowHealthy := make(map[string]bool)

	for _, sess := range sessions {
		if sess.SandboxName == "" || sess.Status == "creating" {
			continue
		}
		active++

		ns := sess.Namespace
		if ns == "" {
			ns = w.cfg.Namespace
		}
		if ns == "" {
			ns = "default"
		}

		pod, err := w.k8s.CoreV1().Pods(ns).Get(ctx, sess.SandboxName, metav1.GetOptions{})
		if err != nil {
			w.markUnhealthy(sess, "", "PodNotFound", fmt.Sprintf("get pod failed: %v", err))
			continue
		}

		issue := checkPodHealth(pod)
		if issue != "" {
			w.markUnhealthy(sess, pod.Spec.NodeName, issue, issue)
		} else {
			nowHealthy[sess.SessionID] = true
			sandboxHealthGauge.WithLabelValues(sess.SessionID, sess.SandboxName, ns, "healthy").Set(1)
		}
	}

	sandboxActiveTotal.Set(float64(active))
	w.resolveRecovered(nowHealthy)
}

func checkPodHealth(pod *corev1.Pod) string {
	switch pod.Status.Phase {
	case corev1.PodFailed:
		if pod.Status.Reason != "" {
			return pod.Status.Reason
		}
		return "PodFailed"
	case corev1.PodUnknown:
		return "PodUnknown"
	}

	for _, cs := range pod.Status.ContainerStatuses {
		if cs.State.Waiting != nil {
			r := cs.State.Waiting.Reason
			if r == "CrashLoopBackOff" || r == "ErrImagePull" || r == "ImagePullBackOff" || r == "CreateContainerConfigError" {
				return r
			}
		}
		if cs.State.Terminated != nil && cs.State.Terminated.ExitCode != 0 {
			return fmt.Sprintf("ContainerTerminated(exit=%d)", cs.State.Terminated.ExitCode)
		}
	}

	if pod.Status.Phase == corev1.PodPending {
		for _, cond := range pod.Status.Conditions {
			if cond.Type == corev1.PodScheduled && cond.Status == corev1.ConditionFalse {
				return "Unschedulable"
			}
		}
	}

	return ""
}

func (w *SandboxWatcher) markUnhealthy(sess *store.SandboxInfo, node, status, reason string) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if _, exists := w.unhealthy[sess.SessionID]; !exists {
		log.Warn("sandbox-watcher: unhealthy pod detected",
			"sessionId", sess.SessionID,
			"pod", sess.SandboxName,
			"namespace", sess.Namespace,
			"node", node,
			"status", status,
		)
	}

	w.unhealthy[sess.SessionID] = &podIssue{
		SessionID:  sess.SessionID,
		PodName:    sess.SandboxName,
		Namespace:  sess.Namespace,
		Status:     status,
		Node:       node,
		Reason:     reason,
		DetectedAt: time.Now(),
	}

	sandboxHealthGauge.WithLabelValues(sess.SessionID, sess.SandboxName, sess.Namespace, status).Set(0)
	sandboxUnhealthyTotal.Set(float64(len(w.unhealthy)))
}

func (w *SandboxWatcher) resolveRecovered(healthy map[string]bool) {
	w.mu.Lock()
	defer w.mu.Unlock()

	for sid, issue := range w.unhealthy {
		if healthy[sid] {
			log.Info("sandbox-watcher: pod recovered",
				"sessionId", sid,
				"pod", issue.PodName,
				"downtime", time.Since(issue.DetectedAt).Round(time.Second),
			)
			sandboxHealthGauge.DeleteLabelValues(sid, issue.PodName, issue.Namespace, issue.Status)
			delete(w.unhealthy, sid)
		}
	}
	sandboxUnhealthyTotal.Set(float64(len(w.unhealthy)))
}
