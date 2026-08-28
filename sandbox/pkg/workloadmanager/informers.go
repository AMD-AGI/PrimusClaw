// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Package workloadmanager — Dynamic Informer cache for CRD resources.
// WM reads CodeInterpreter from local Informer cache instead of
// querying API Server on every sandbox creation, reducing latency and load.
package workloadmanager

import (
	"context"
	"fmt"
	"time"

	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic/dynamicinformer"
	"k8s.io/client-go/tools/cache"
)

var (
	// CodeInterpreterGVR is the GroupVersionResource for CodeInterpreter CRD.
	CodeInterpreterGVR = schema.GroupVersionResource{
		Group:    "runtime.agent-sandbox.io",
		Version:  "v1alpha1",
		Resource: "codeinterpreters",
	}
	// SandboxGVR is the GroupVersionResource for Sandbox.
	SandboxGVR = schema.GroupVersionResource{
		Group:    "agents.x-k8s.io",
		Version:  "v1alpha1",
		Resource: "sandboxes",
	}
	// SandboxClaimGVR is the GroupVersionResource for SandboxClaim.
	SandboxClaimGVR = schema.GroupVersionResource{
		Group:    "extensions.agents.x-k8s.io",
		Version:  "v1alpha1",
		Resource: "sandboxclaims",
	}
)

// CRDInformers holds shared informers for agent-sandbox CRD resources.
type CRDInformers struct {
	CodeInterpreterInformer cache.SharedIndexInformer
	factory                 dynamicinformer.DynamicSharedInformerFactory
}

// NewCRDInformers creates CRDInformers from a DynamicSharedInformerFactory.
func NewCRDInformers(factory dynamicinformer.DynamicSharedInformerFactory) *CRDInformers {
	return &CRDInformers{
		CodeInterpreterInformer: factory.ForResource(CodeInterpreterGVR).Informer(),
		factory:                 factory,
	}
}

// CRDCacheSyncTimeout bounds the initial cache sync.
//
// This runs in the unified control plane before router.New, so it is spent
// with nothing listening on the router port while the startupProbe counts
// down. At the 60s it used to be, this one call could consume the entire
// probe window on its own and the kubelet would kill the container before the
// Router ever got to start -- reported as "startup probe failed", which names
// the symptom and not one of the two things that produced it. Sized so this
// plus the rest of startup, the Router's own JWT identity budget included,
// fits inside the window with room left over.
//
// Exported because that arithmetic only holds if both numbers move together;
// pkg/router's jwt_test.go asserts the sum against the probe window.
const CRDCacheSyncTimeout = 30 * time.Second

// RunAndWaitForCacheSync starts informers and waits for the initial cache sync.
// Should be called before handling any requests.
func (inf *CRDInformers) RunAndWaitForCacheSync(ctx context.Context) error {
	inf.factory.Start(ctx.Done())
	go inf.CodeInterpreterInformer.Run(ctx.Done())

	syncCtx, cancel := context.WithTimeout(ctx, CRDCacheSyncTimeout)
	defer cancel()

	if !cache.WaitForCacheSync(syncCtx.Done(), inf.CodeInterpreterInformer.HasSynced) {
		return fmt.Errorf("timed out waiting for CodeInterpreter informer cache sync")
	}
	return nil
}
