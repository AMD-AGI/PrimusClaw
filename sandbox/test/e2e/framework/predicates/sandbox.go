// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package predicates

import (
	"fmt"

	"github.com/google/go-cmp/cmp"
	"github.com/google/go-cmp/cmp/cmpopts"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	sandboxv1alpha1 "sigs.k8s.io/agent-sandbox/api/v1alpha1"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

func asSandbox(obj client.Object) (*sandboxv1alpha1.Sandbox, error) {
	if obj == nil {
		return nil, fmt.Errorf("sandbox object is nil")
	}
	sandbox, err := asTyped[*sandboxv1alpha1.Sandbox](obj)
	if err != nil {
		return nil, err
	}
	return sandbox, nil
}

// SandboxHasStatus verifies that the Sandbox object has the specified status
func SandboxHasStatus(status sandboxv1alpha1.SandboxStatus) ObjectPredicate {
	return &sandboxHasStatusPredicate{
		WantStatus: status,
	}
}

type sandboxHasStatusPredicate struct {
	WantStatus sandboxv1alpha1.SandboxStatus
}

func (s *sandboxHasStatusPredicate) String() string {
	return fmt.Sprintf("SandboxHasStatus(%v)", s.WantStatus)
}

func (s *sandboxHasStatusPredicate) Matches(obj client.Object) (bool, error) {
	sandbox, err := asSandbox(obj)
	if err != nil {
		return false, err
	}
	opts := []cmp.Option{
		cmpopts.IgnoreFields(metav1.Condition{}, "LastTransitionTime"),
	}
	if diff := cmp.Diff(s.WantStatus, sandbox.Status, opts...); diff != "" {
		return false, nil
	}
	return true, nil
}
