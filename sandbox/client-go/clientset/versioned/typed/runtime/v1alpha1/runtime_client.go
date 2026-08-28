// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package v1alpha1

import (
	"net/http"

	"k8s.io/client-go/rest"

	scheme "sigs.k8s.io/agent-sandbox/client-go/clientset/versioned/scheme"
	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
)

// RuntimeV1alpha1Interface provides access to CodeInterpreter resources.
type RuntimeV1alpha1Interface interface {
	RESTClient() rest.Interface
	CodeInterpretersGetter
}

// RuntimeV1alpha1Client is the typed client for runtime.agent-sandbox.io/v1alpha1.
type RuntimeV1alpha1Client struct {
	restClient rest.Interface
}

func (c *RuntimeV1alpha1Client) CodeInterpreters(namespace string) CodeInterpreterInterface {
	return newCodeInterpreters(c, namespace)
}

// NewForConfig creates a new RuntimeV1alpha1Client from a rest.Config.
func NewForConfig(c *rest.Config) (*RuntimeV1alpha1Client, error) {
	config := *c
	setConfigDefaults(&config)
	httpClient, err := rest.HTTPClientFor(&config)
	if err != nil {
		return nil, err
	}
	return NewForConfigAndClient(&config, httpClient)
}

// NewForConfigAndClient creates a new RuntimeV1alpha1Client from config and HTTP client.
func NewForConfigAndClient(c *rest.Config, h *http.Client) (*RuntimeV1alpha1Client, error) {
	config := *c
	setConfigDefaults(&config)
	client, err := rest.RESTClientForConfigAndClient(&config, h)
	if err != nil {
		return nil, err
	}
	return &RuntimeV1alpha1Client{client}, nil
}

// NewForConfigOrDie panics if there is an error.
func NewForConfigOrDie(c *rest.Config) *RuntimeV1alpha1Client {
	client, err := NewForConfig(c)
	if err != nil {
		panic(err)
	}
	return client
}

func (c *RuntimeV1alpha1Client) RESTClient() rest.Interface {
	if c == nil {
		return nil
	}
	return c.restClient
}

func setConfigDefaults(config *rest.Config) {
	gv := runtimev1alpha1.GroupVersion
	config.GroupVersion = &gv
	config.APIPath = "/apis"
	config.NegotiatedSerializer = rest.CodecFactoryForGeneratedClient(scheme.Scheme, scheme.Codecs).WithoutConversion()
	if config.UserAgent == "" {
		config.UserAgent = rest.DefaultKubernetesUserAgent()
	}
}
