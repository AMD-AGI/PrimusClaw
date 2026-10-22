// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	sandboxv1alpha1 "sigs.k8s.io/agent-sandbox/api/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/api"
)

func TestSandboxInfoFromCRIgnoresSpoofedSessionIDAnnotation(t *testing.T) {
	t.Parallel()
	sb := &sandboxv1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "att",
			Namespace: "attns",
			Annotations: map[string]string{
				sessionIDAnnotationKey: "victimns/victim",
			},
			Labels: map[string]string{
				userIDLabelKey: "attacker",
			},
		},
		Status: sandboxv1alpha1.SandboxStatus{
			Service:  "att",
			Replicas: 1,
			Conditions: []metav1.Condition{{
				Type:   string(sandboxv1alpha1.SandboxConditionReady),
				Status: "True",
			}},
		},
	}

	info, err := sandboxInfoFromCR(sb)
	if err != nil {
		t.Fatalf("sandboxInfoFromCR: %v", err)
	}
	want := api.FormatSandboxID("attns", "att")
	if info.SessionID != want {
		t.Fatalf("SessionID = %q, want canonical %q (must not trust annotation)", info.SessionID, want)
	}
	if info.Status != "running" {
		t.Fatalf("Status = %q, want running", info.Status)
	}
}

func TestSandboxInfoFromCRUsesAdoptedPodName(t *testing.T) {
	t.Parallel()
	sb := &sandboxv1alpha1.Sandbox{
		ObjectMeta: metav1.ObjectMeta{
			Name:      "claim-1",
			Namespace: "default",
			Annotations: map[string]string{
				"agents.x-k8s.io/pod-name": "warm-pod-xyz",
			},
		},
	}
	info, err := sandboxInfoFromCR(sb)
	if err != nil {
		t.Fatalf("sandboxInfoFromCR: %v", err)
	}
	if info.PodName != "warm-pod-xyz" {
		t.Fatalf("PodName = %q, want warm-pod-xyz", info.PodName)
	}
}
