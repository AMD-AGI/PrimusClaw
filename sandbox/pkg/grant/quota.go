// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import (
	"net/http"
	"time"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
)

// usable reports whether the grant may still accept a create at now.
func usable(g *runtimev1alpha1.SandboxGrant, now time.Time) error {
	switch g.Status.State {
	case runtimev1alpha1.GrantStateRevoked:
		return opErr(http.StatusUnauthorized, "grant_revoked", g.Name)
	case runtimev1alpha1.GrantStateExpired:
		return opErr(http.StatusUnauthorized, "grant_expired", g.Name)
	}
	if !g.Spec.ExpiresAt.IsZero() && !now.Before(g.Spec.ExpiresAt.Time) {
		return opErr(http.StatusUnauthorized, "grant_expired", g.Name)
	}
	if g.Status.State != "" && g.Status.State != runtimev1alpha1.GrantStateActive {
		return opErr(http.StatusUnauthorized, "grant_revoked", g.Status.State)
	}
	return nil
}

// reserveOne charges one sandbox to the grant. A repeated sandbox id is a no-op.
func reserveOne(g *runtimev1alpha1.SandboxGrant, role, sandboxID, sessionID string, gpus int32, now time.Time) error {
	if err := usable(g, now); err != nil {
		return err
	}
	for _, ref := range g.Status.Sandboxes {
		if ref.ID == sandboxID {
			return nil
		}
	}
	limit, ok := g.Spec.Roles[role]
	if !ok {
		return opErr(http.StatusForbidden, "role_not_allowed", role)
	}
	if gpus < 0 {
		return opErr(http.StatusBadRequest, "invalid_grant", "gpus must be >= 0")
	}
	if err := checkQuota(g, role, limit, gpus); err != nil {
		return err
	}
	usage := g.Status.Usage[role]
	if g.Status.Usage == nil {
		g.Status.Usage = map[string]runtimev1alpha1.GrantRoleUsage{}
	}
	usage.Sandboxes++
	usage.GPUs += gpus
	g.Status.Usage[role] = usage
	g.Status.Sandboxes = append(g.Status.Sandboxes, runtimev1alpha1.GrantSandboxRef{
		ID:        sandboxID,
		Role:      role,
		GPUs:      gpus,
		SessionID: sessionID,
		StartedAt: metav1.NewTime(now),
	})
	return nil
}

// releaseOne drops a sandbox from the grant and records its GPU seconds.
func releaseOne(g *runtimev1alpha1.SandboxGrant, sandboxID string, gpuSeconds int64) bool {
	idx := -1
	for i, ref := range g.Status.Sandboxes {
		if ref.ID == sandboxID {
			idx = i
			break
		}
	}
	if idx < 0 {
		return false
	}
	ref := g.Status.Sandboxes[idx]
	g.Status.Sandboxes = append(g.Status.Sandboxes[:idx], g.Status.Sandboxes[idx+1:]...)
	if g.Status.Usage != nil {
		usage := g.Status.Usage[ref.Role]
		usage.Sandboxes--
		usage.GPUs -= ref.GPUs
		if usage.Sandboxes < 0 {
			usage.Sandboxes = 0
		}
		if usage.GPUs < 0 {
			usage.GPUs = 0
		}
		g.Status.Usage[ref.Role] = usage
	}
	if gpuSeconds > 0 {
		g.Status.GPUSeconds += gpuSeconds
	}
	return true
}

// checkQuota refuses one more sandbox with gpus GPUs in role when it passes the role cap, the grant cap summed
// over every role, or the GPU-hour budget. The detail names the cap, the request, the usage, and the limit.
func checkQuota(g *runtimev1alpha1.SandboxGrant, role string, limit runtimev1alpha1.GrantRole, gpus int32) error {
	usage := g.Status.Usage[role]
	if limit.MaxSandboxes >= 0 && usage.Sandboxes+1 > limit.MaxSandboxes {
		return quotaExceeded(role+" sandboxes", 1, usage.Sandboxes, limit.MaxSandboxes)
	}
	if limit.MaxGPUs >= 0 && usage.GPUs+gpus > limit.MaxGPUs {
		return quotaExceeded(role+" gpus", gpus, usage.GPUs, limit.MaxGPUs)
	}
	var total runtimev1alpha1.GrantRoleUsage
	for _, u := range g.Status.Usage {
		total.Sandboxes += u.Sandboxes
		total.GPUs += u.GPUs
	}
	if g.Spec.MaxSandboxes != nil && total.Sandboxes+1 > *g.Spec.MaxSandboxes {
		return quotaExceeded("grant sandboxes", 1, total.Sandboxes, *g.Spec.MaxSandboxes)
	}
	if g.Spec.MaxGPUs != nil && total.GPUs+gpus > *g.Spec.MaxGPUs {
		return quotaExceeded("grant gpus", gpus, total.GPUs, *g.Spec.MaxGPUs)
	}
	if overBudget(g) {
		return opErr(http.StatusTooManyRequests, "grant_quota_exceeded",
			fmtDetail("grant gpu hours: used %.2f, limit %.2f", float64(g.Status.GPUSeconds)/3600, g.Spec.GPUHoursBudget))
	}
	return nil
}

// quotaExceeded is the 429 for a count cap.
func quotaExceeded(scope string, requested, inUse, limit int32) error {
	return opErr(http.StatusTooManyRequests, "grant_quota_exceeded",
		fmtDetail("%s: requested %d, in use %d, limit %d", scope, requested, inUse, limit))
}

func overBudget(g *runtimev1alpha1.SandboxGrant) bool {
	if g.Spec.GPUHoursBudget <= 0 {
		return false
	}
	capSeconds := int64(g.Spec.GPUHoursBudget * 3600)
	return g.Status.GPUSeconds >= capSeconds
}
