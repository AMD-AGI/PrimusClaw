// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package predicates

import (
	"fmt"

	"github.com/google/go-cmp/cmp"
	"github.com/google/go-cmp/cmp/cmpopts"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

// HasAnnotation verifies the object has the specified annotation
func HasAnnotation(key, wantVal string) ObjectPredicate {
	return &AnnotationPredicate{
		Key:     key,
		WantVal: wantVal,
	}
}

type AnnotationPredicate struct {
	Key     string
	WantVal string
}

func (a *AnnotationPredicate) String() string {
	return fmt.Sprintf("HasAnnotation(%s=%s)", a.Key, a.WantVal)
}

func (a *AnnotationPredicate) Matches(obj client.Object) (bool, error) {
	if obj == nil {
		return false, fmt.Errorf("object is nil")
	}
	if got, ok := obj.GetAnnotations()[a.Key]; !ok {
		return false, fmt.Errorf("annotation %s missing", a.Key)
	} else if a.WantVal != got {
		return false, nil
	}
	return true, nil
}

// HasLabel verifies the object has the specified label
func HasLabel(key, wantVal string) ObjectPredicate {
	return &LabelPredicate{
		Key:     key,
		WantVal: wantVal,
	}
}

type LabelPredicate struct {
	Key     string
	WantVal string
}

func (l *LabelPredicate) String() string {
	return fmt.Sprintf("HasLabel(%s=%s)", l.Key, l.WantVal)
}

func (l *LabelPredicate) Matches(obj client.Object) (bool, error) {
	if obj == nil {
		return false, fmt.Errorf("object is nil")
	}
	if got, ok := obj.GetLabels()[l.Key]; !ok {
		return false, fmt.Errorf("label %s missing", l.Key)
	} else if l.WantVal != got {
		return false, nil
	}
	return true, nil
}

// HasOwnerReferences verifies the object has the specified owner references
func HasOwnerReferences(want []metav1.OwnerReference) ObjectPredicate {
	return HasOwnerReferencePredicate{Want: want}
}

type HasOwnerReferencePredicate struct {
	Want []metav1.OwnerReference
}

func (h HasOwnerReferencePredicate) String() string {
	return fmt.Sprintf("HasOwnerReferences(%v)", h.Want)
}

func (h HasOwnerReferencePredicate) Matches(obj client.Object) (bool, error) {
	if obj == nil {
		return false, fmt.Errorf("object is nil")
	}
	opts := []cmp.Option{
		cmpopts.SortSlices(func(a, b metav1.OwnerReference) bool { return a.UID < b.UID }),
	}
	if diff := cmp.Diff(h.Want, obj.GetOwnerReferences(), opts...); diff != "" {
		return false, nil
	}
	return true, nil
}

// NotDeleted verifies the object has no deletion timestamp
func NotDeleted() ObjectPredicate {
	return &NotDeletedPredicate{}
}

type NotDeletedPredicate struct{}

func (n *NotDeletedPredicate) String() string {
	return "NotDeletedPredicate"
}

func (n *NotDeletedPredicate) Matches(obj client.Object) (bool, error) {
	if obj == nil {
		return false, fmt.Errorf("object is nil")
	}
	deletionTimestamp := obj.GetDeletionTimestamp()
	if deletionTimestamp != nil {
		return false, nil
	}
	return true, nil
}
