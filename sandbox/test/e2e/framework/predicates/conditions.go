// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package predicates

import (
	"fmt"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

// objectWithStatus is a simplified struct to parse the status of a resource.
type objectWithStatus struct {
	Status struct {
		Conditions    []metav1.Condition `json:"conditions,omitempty"`
		ReadyReplicas int                `json:"readyReplicas,omitempty"`
	} `json:"status"`
	Spec struct {
		Replicas int `json:"replicas,omitempty"`
	} `json:"spec"`
}

// ReadyConditionIsTrue checks if the given object has a Ready condition set to True.
var ReadyConditionIsTrue = &StatusPredicate{
	MatchType:   "Ready",
	MatchStatus: metav1.ConditionTrue,
}

type StatusPredicate struct {
	MatchType   string
	MatchStatus metav1.ConditionStatus
}

func (s *StatusPredicate) Matches(obj client.Object) (bool, error) {
	u, err := asUnstructured(obj)
	if err != nil {
		return false, fmt.Errorf("failed to convert to unstructured: %w", err)
	}

	var status objectWithStatus
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(u.Object, &status); err != nil {
		return false, fmt.Errorf("failed to convert to objectWithStatus: %v", err)
	}

	for _, cond := range status.Status.Conditions {
		if cond.Type == s.MatchType && cond.Status == s.MatchStatus {
			return true, nil
		}
	}
	return false, nil
}

func (s *StatusPredicate) String() string {
	return fmt.Sprintf("StatusPredicate(Type=%s,Status=%s)", s.MatchType, s.MatchStatus)
}

// asUnstructured converts a client.Object to an *unstructured.Unstructured.
func asUnstructured(obj client.Object) (*unstructured.Unstructured, error) {
	if u, ok := obj.(*unstructured.Unstructured); ok {
		return u, nil
	}

	m, err := runtime.DefaultUnstructuredConverter.ToUnstructured(obj)
	if err != nil {
		return nil, fmt.Errorf("converting object of type %T to unstructured: %w", obj, err)
	}
	return &unstructured.Unstructured{Object: m}, nil
}

// asTyped attempts to convert a client.Object to a specific type T.
func asTyped[T any](obj client.Object) (T, error) {
	if t, ok := obj.(T); ok {
		return t, nil
	}

	if u, ok := obj.(*unstructured.Unstructured); ok {
		var typedObj T
		if err := runtime.DefaultUnstructuredConverter.FromUnstructured(u.Object, &typedObj); err != nil {
			var zero T
			return zero, fmt.Errorf("converting unstructured to type %T: %w", typedObj, err)
		}
		return typedObj, nil
	}

	var zero T
	return zero, fmt.Errorf("got %T, want %T", obj, zero)
}

// ReadyReplicasConditionIsTrue checks if the given object has more than 0 replicas.
var ReadyReplicasConditionIsTrue = &ReadyReplicasPredicate{}

type ReadyReplicasPredicate struct{}

func (s *ReadyReplicasPredicate) String() string {
	return "ReadyReplicasPredicate(Has all replicas ready)"
}

func (s *ReadyReplicasPredicate) Matches(obj client.Object) (bool, error) {
	u, err := asUnstructured(obj)
	if err != nil {
		return false, fmt.Errorf("failed to convert to unstructured: %w", err)
	}

	var status objectWithStatus
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(u.Object, &status); err != nil {
		return false, fmt.Errorf("failed to convert to objectWithStatus: %v", err)
	}
	if status.Status.ReadyReplicas == status.Spec.Replicas {
		return true, nil
	}
	return false, nil
}
