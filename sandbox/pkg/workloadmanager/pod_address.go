// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package workloadmanager

import (
	"context"
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"
)

// PodAddressFinder lists pods for a SaFE Workload in this cluster.
type PodAddressFinder struct {
	client ctrlclient.Client
}

// NewPodAddressFinder uses the controller client of the cluster this process runs in.
func NewPodAddressFinder(client ctrlclient.Client) *PodAddressFinder {
	return &PodAddressFinder{client: client}
}

// PodAddress returns the envd address of the Workload named sandboxID.
// Several pods use the master pod. A single pod uses that pod.
func (f *PodAddressFinder) PodAddress(ctx context.Context, sandboxID string) (string, int, error) {
	if f == nil || f.client == nil || sandboxID == "" {
		return "", 0, fmt.Errorf("pod address client is not configured")
	}
	var pods corev1.PodList
	if err := f.client.List(ctx, &pods, ctrlclient.MatchingLabels{safeWorkloadIDLabel: sandboxID}); err != nil {
		return "", 0, err
	}
	pod := pickEnvDPod(pods.Items)
	if pod == nil {
		return "", 0, fmt.Errorf("no pod for workload %s", sandboxID)
	}
	return pod.Status.PodIP, envdPort, nil
}

// pickEnvDPod prefers the PyTorchJob master and otherwise the first pod with an IP.
func pickEnvDPod(pods []corev1.Pod) *corev1.Pod {
	var first *corev1.Pod
	for i := range pods {
		pod := &pods[i]
		if pod.DeletionTimestamp != nil || pod.Status.PodIP == "" {
			continue
		}
		if strings.HasSuffix(pod.Name, "-master-0") {
			return pod
		}
		if first == nil {
			first = pod
		}
	}
	return first
}
