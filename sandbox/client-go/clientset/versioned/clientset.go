// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Package versioned provides a typed Kubernetes client for agent-sandbox CRDs.
//
// Usage:
//
//	cfg, _ := rest.InClusterConfig()
//	client, _ := versioned.NewForConfig(cfg)
//
//	// List CodeInterpreters
//	cis, _ := client.RuntimeV1alpha1().CodeInterpreters("default").List(ctx, metav1.ListOptions{})
//

package versioned

import (
	"net/http"

	"k8s.io/client-go/rest"

	runtimev1alpha1client "sigs.k8s.io/agent-sandbox/client-go/clientset/versioned/typed/runtime/v1alpha1"
)

// Interface provides access to all CRD groups.
type Interface interface {
	RuntimeV1alpha1() runtimev1alpha1client.RuntimeV1alpha1Interface
}

// Clientset contains typed clients for all CRD groups.
type Clientset struct {
	runtimeV1alpha1 *runtimev1alpha1client.RuntimeV1alpha1Client
}

// RuntimeV1alpha1 returns a RuntimeV1alpha1Interface.
func (c *Clientset) RuntimeV1alpha1() runtimev1alpha1client.RuntimeV1alpha1Interface {
	return c.runtimeV1alpha1
}

// NewForConfig creates a Clientset from a rest.Config.
func NewForConfig(c *rest.Config) (*Clientset, error) {
	runtimeClient, err := runtimev1alpha1client.NewForConfig(c)
	if err != nil {
		return nil, err
	}
	return &Clientset{runtimeV1alpha1: runtimeClient}, nil
}

// NewForConfigAndClient creates a Clientset with a custom HTTP client.
func NewForConfigAndClient(c *rest.Config, httpClient *http.Client) (*Clientset, error) {
	runtimeClient, err := runtimev1alpha1client.NewForConfigAndClient(c, httpClient)
	if err != nil {
		return nil, err
	}
	return &Clientset{runtimeV1alpha1: runtimeClient}, nil
}

// NewForConfigOrDie panics on error.
func NewForConfigOrDie(c *rest.Config) *Clientset {
	cs, err := NewForConfig(c)
	if err != nil {
		panic(err)
	}
	return cs
}
