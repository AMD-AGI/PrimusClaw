// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Package v1alpha1 provides typed clients for runtime.agent-sandbox.io/v1alpha1.
package v1alpha1

import (
	"context"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/rest"

	scheme "sigs.k8s.io/agent-sandbox/client-go/clientset/versioned/scheme"
	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
)

// CodeInterpretersGetter has a method to return a CodeInterpreterInterface.
type CodeInterpretersGetter interface {
	CodeInterpreters(namespace string) CodeInterpreterInterface
}

// CodeInterpreterInterface has methods to work with CodeInterpreter resources.
type CodeInterpreterInterface interface {
	Create(ctx context.Context, ci *runtimev1alpha1.CodeInterpreter, opts metav1.CreateOptions) (*runtimev1alpha1.CodeInterpreter, error)
	Update(ctx context.Context, ci *runtimev1alpha1.CodeInterpreter, opts metav1.UpdateOptions) (*runtimev1alpha1.CodeInterpreter, error)
	UpdateStatus(ctx context.Context, ci *runtimev1alpha1.CodeInterpreter, opts metav1.UpdateOptions) (*runtimev1alpha1.CodeInterpreter, error)
	Delete(ctx context.Context, name string, opts metav1.DeleteOptions) error
	Get(ctx context.Context, name string, opts metav1.GetOptions) (*runtimev1alpha1.CodeInterpreter, error)
	List(ctx context.Context, opts metav1.ListOptions) (*runtimev1alpha1.CodeInterpreterList, error)
	Watch(ctx context.Context, opts metav1.ListOptions) (watch.Interface, error)
	Patch(ctx context.Context, name string, pt types.PatchType, data []byte, opts metav1.PatchOptions, subresources ...string) (*runtimev1alpha1.CodeInterpreter, error)
}

type codeInterpreters struct {
	client rest.Interface
	ns     string
}

func newCodeInterpreters(c *RuntimeV1alpha1Client, namespace string) *codeInterpreters {
	return &codeInterpreters{client: c.RESTClient(), ns: namespace}
}

func (c *codeInterpreters) Get(ctx context.Context, name string, opts metav1.GetOptions) (*runtimev1alpha1.CodeInterpreter, error) {
	result := &runtimev1alpha1.CodeInterpreter{}
	err := c.client.Get().
		Namespace(c.ns).
		Resource("codeinterpreters").
		Name(name).
		VersionedParams(&opts, scheme.ParameterCodec).
		Do(ctx).
		Into(result)
	return result, err
}

func (c *codeInterpreters) List(ctx context.Context, opts metav1.ListOptions) (*runtimev1alpha1.CodeInterpreterList, error) {
	result := &runtimev1alpha1.CodeInterpreterList{}
	err := c.client.Get().
		Namespace(c.ns).
		Resource("codeinterpreters").
		VersionedParams(&opts, scheme.ParameterCodec).
		Do(ctx).
		Into(result)
	return result, err
}

func (c *codeInterpreters) Watch(ctx context.Context, opts metav1.ListOptions) (watch.Interface, error) {
	opts.Watch = true
	return c.client.Get().
		Namespace(c.ns).
		Resource("codeinterpreters").
		VersionedParams(&opts, scheme.ParameterCodec).
		Watch(ctx)
}

func (c *codeInterpreters) Create(ctx context.Context, ci *runtimev1alpha1.CodeInterpreter, opts metav1.CreateOptions) (*runtimev1alpha1.CodeInterpreter, error) {
	result := &runtimev1alpha1.CodeInterpreter{}
	err := c.client.Post().
		Namespace(c.ns).
		Resource("codeinterpreters").
		VersionedParams(&opts, scheme.ParameterCodec).
		Body(ci).
		Do(ctx).
		Into(result)
	return result, err
}

func (c *codeInterpreters) Update(ctx context.Context, ci *runtimev1alpha1.CodeInterpreter, opts metav1.UpdateOptions) (*runtimev1alpha1.CodeInterpreter, error) {
	result := &runtimev1alpha1.CodeInterpreter{}
	err := c.client.Put().
		Namespace(c.ns).
		Resource("codeinterpreters").
		Name(ci.Name).
		VersionedParams(&opts, scheme.ParameterCodec).
		Body(ci).
		Do(ctx).
		Into(result)
	return result, err
}

func (c *codeInterpreters) UpdateStatus(ctx context.Context, ci *runtimev1alpha1.CodeInterpreter, opts metav1.UpdateOptions) (*runtimev1alpha1.CodeInterpreter, error) {
	result := &runtimev1alpha1.CodeInterpreter{}
	err := c.client.Put().
		Namespace(c.ns).
		Resource("codeinterpreters").
		Name(ci.Name).
		SubResource("status").
		VersionedParams(&opts, scheme.ParameterCodec).
		Body(ci).
		Do(ctx).
		Into(result)
	return result, err
}

func (c *codeInterpreters) Delete(ctx context.Context, name string, opts metav1.DeleteOptions) error {
	return c.client.Delete().
		Namespace(c.ns).
		Resource("codeinterpreters").
		Name(name).
		Body(&opts).
		Do(ctx).
		Error()
}

func (c *codeInterpreters) Patch(ctx context.Context, name string, pt types.PatchType, data []byte, opts metav1.PatchOptions, subresources ...string) (*runtimev1alpha1.CodeInterpreter, error) {
	result := &runtimev1alpha1.CodeInterpreter{}
	err := c.client.Patch(pt).
		Namespace(c.ns).
		Resource("codeinterpreters").
		Name(name).
		SubResource(subresources...).
		VersionedParams(&opts, scheme.ParameterCodec).
		Body(data).
		Do(ctx).
		Into(result)
	return result, err
}
