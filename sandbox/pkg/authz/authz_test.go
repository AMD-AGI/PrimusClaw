// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package authz

import (
	"context"
	"errors"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
	authorizationv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"sigs.k8s.io/agent-sandbox/pkg/identity"
)

// verbReviewer allows the verbs named in allow. err fails every review.
type verbReviewer struct {
	allow map[string]bool
	err   error
}

func (r verbReviewer) Create(_ context.Context, sar *authorizationv1.SubjectAccessReview, _ metav1.CreateOptions) (*authorizationv1.SubjectAccessReview, error) {
	if r.err != nil {
		return nil, r.err
	}
	out := sar.DeepCopy()
	if sar.Spec.ResourceAttributes != nil {
		out.Status.Allowed = r.allow[sar.Spec.ResourceAttributes.Verb]
	}
	return out, nil
}

func metric(question, result string) float64 {
	return testutil.ToFloat64(reviews.WithLabelValues(question, result))
}

func TestPlatformRoleAdminMayDeleteSessions(t *testing.T) {
	before := metric("sessions", "allow")
	c := NewClient(verbReviewer{allow: map[string]bool{"delete": true}}, "primus:")
	role, err := c.PlatformRole(context.Background(), "u-admin", []string{"system-admin"})
	if err != nil || role != identity.RoleSystemAdmin {
		t.Fatalf("role=%q err=%v", role, err)
	}
	if metric("sessions", "allow") != before+1 {
		t.Fatal("an allowed delete review was not counted")
	}
}

func TestPlatformRoleReadonlyMayListSessions(t *testing.T) {
	deny, allow := metric("sessions", "deny"), metric("sessions", "allow")
	c := NewClient(verbReviewer{allow: map[string]bool{"list": true}}, "primus:")
	role, err := c.PlatformRole(context.Background(), "u-audit", []string{"system-admin-readonly"})
	if err != nil || role != identity.RoleSystemAdminReadonly {
		t.Fatalf("role=%q err=%v", role, err)
	}
	if metric("sessions", "deny") != deny+1 || metric("sessions", "allow") != allow+1 {
		t.Fatal("readonly is a denied delete and an allowed list")
	}
}

func TestPlatformRoleDefaultMayNeither(t *testing.T) {
	deny := metric("sessions", "deny")
	c := NewClient(verbReviewer{}, "primus:")
	role, err := c.PlatformRole(context.Background(), "u-1", nil)
	if err != nil || role != identity.RoleDefault {
		t.Fatalf("role=%q err=%v", role, err)
	}
	if metric("sessions", "deny") != deny+2 {
		t.Fatal("a default user is denied both delete and list")
	}
}

func TestPlatformRoleReviewErrorIsUnavailable(t *testing.T) {
	before := metric("sessions", "unavailable")
	c := NewClient(verbReviewer{err: errors.New("apiserver down")}, "primus:")
	role, err := c.PlatformRole(context.Background(), "u-1", nil)
	if err == nil || !errors.Is(err, ErrUnavailable) || role != "" {
		t.Fatalf("role=%q err=%v", role, err)
	}
	if metric("sessions", "unavailable") != before+1 {
		t.Fatal("a failed review was not counted separately from a denial")
	}
}
