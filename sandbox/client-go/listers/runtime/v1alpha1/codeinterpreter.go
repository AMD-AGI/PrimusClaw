// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Package v1alpha1 provides Listers for runtime.agent-sandbox.io/v1alpha1.
package v1alpha1

import (
	"k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/client-go/tools/cache"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
)

// CodeInterpreterLister reads CodeInterpreters from the informer cache.
type CodeInterpreterLister interface {
	List(selector labels.Selector) ([]*runtimev1alpha1.CodeInterpreter, error)
	CodeInterpreters(namespace string) CodeInterpreterNamespaceLister
}

// CodeInterpreterNamespaceLister reads CodeInterpreters in a specific namespace.
type CodeInterpreterNamespaceLister interface {
	List(selector labels.Selector) ([]*runtimev1alpha1.CodeInterpreter, error)
	Get(name string) (*runtimev1alpha1.CodeInterpreter, error)
}

type codeInterpreterLister struct {
	indexer cache.Indexer
}

// NewCodeInterpreterLister creates a new lister backed by the given indexer.
func NewCodeInterpreterLister(indexer cache.Indexer) CodeInterpreterLister {
	return &codeInterpreterLister{indexer: indexer}
}

func (l *codeInterpreterLister) List(selector labels.Selector) ([]*runtimev1alpha1.CodeInterpreter, error) {
	var result []*runtimev1alpha1.CodeInterpreter
	err := cache.ListAll(l.indexer, selector, func(obj interface{}) {
		result = append(result, obj.(*runtimev1alpha1.CodeInterpreter))
	})
	return result, err
}

func (l *codeInterpreterLister) CodeInterpreters(namespace string) CodeInterpreterNamespaceLister {
	return &codeInterpreterNamespaceLister{indexer: l.indexer, namespace: namespace}
}

type codeInterpreterNamespaceLister struct {
	indexer   cache.Indexer
	namespace string
}

func (l *codeInterpreterNamespaceLister) List(selector labels.Selector) ([]*runtimev1alpha1.CodeInterpreter, error) {
	var result []*runtimev1alpha1.CodeInterpreter
	err := cache.ListAllByNamespace(l.indexer, l.namespace, selector, func(obj interface{}) {
		result = append(result, obj.(*runtimev1alpha1.CodeInterpreter))
	})
	return result, err
}

func (l *codeInterpreterNamespaceLister) Get(name string) (*runtimev1alpha1.CodeInterpreter, error) {
	key := l.namespace + "/" + name
	obj, exists, err := l.indexer.GetByKey(key)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, errors.NewNotFound(runtimev1alpha1.GroupVersion.WithResource("codeinterpreters").GroupResource(), name)
	}
	return obj.(*runtimev1alpha1.CodeInterpreter), nil
}
