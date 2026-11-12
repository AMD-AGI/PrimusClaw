// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package authz

import (
	"context"
	"errors"
	"reflect"
	"testing"

	"github.com/prometheus/client_golang/prometheus/testutil"
	authorizationv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	k8sfake "k8s.io/client-go/kubernetes/fake"

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
	role, err := c.PlatformRole(context.Background(), identity.Token{Subject: "u-admin", Groups: []string{"system-admin"}})
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
	role, err := c.PlatformRole(context.Background(), identity.Token{Subject: "u-audit", Groups: []string{"system-admin-readonly"}})
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
	role, err := c.PlatformRole(context.Background(), identity.Token{Subject: "u-1"})
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
	role, err := c.PlatformRole(context.Background(), identity.Token{Subject: "u-1"})
	if err == nil || !errors.Is(err, ErrUnavailable) || role != "" {
		t.Fatalf("role=%q err=%v", role, err)
	}
	if metric("sessions", "unavailable") != before+1 {
		t.Fatal("a failed review was not counted separately from a denial")
	}
}

func TestFromClientsetRejectsAnEmptyPrefix(t *testing.T) {
	t.Setenv(PrefixEnv, " ")
	if _, err := FromClientset(k8sfake.NewSimpleClientset()); err == nil {
		t.Fatal("empty RBAC_SUBJECT_PREFIX was accepted")
	}
	t.Setenv(PrefixEnv, "primus:")
	if c, err := FromClientset(k8sfake.NewSimpleClientset()); err != nil || c.prefix != "primus:" {
		t.Fatalf("client = %+v, %v", c, err)
	}
}

// recordingReviewer keeps the last SubjectAccessReviewSpec.
type recordingReviewer struct {
	spec  authorizationv1.SubjectAccessReviewSpec
	calls int
}

func (r *recordingReviewer) Create(_ context.Context, sar *authorizationv1.SubjectAccessReview, _ metav1.CreateOptions) (*authorizationv1.SubjectAccessReview, error) {
	r.calls++
	r.spec = sar.Spec
	out := sar.DeepCopy()
	out.Status.Allowed = true
	return out, nil
}

func TestWorkspaceUseReviewSpec(t *testing.T) {
	rec := &recordingReviewer{}
	c := NewClient(rec, "primus:")
	tok := identity.Token{Subject: "u-1", Roles: []string{"system-admin"}, Groups: []string{"b", "", "a"}}
	ok, err := c.CanUseWorkspace(context.Background(), tok, "lab")
	if err != nil || !ok {
		t.Fatalf("allowed=%v err=%v", ok, err)
	}
	want := authorizationv1.SubjectAccessReviewSpec{
		User:   "primus:u-1",
		Groups: []string{"primus:a", "primus:b"},
		ResourceAttributes: &authorizationv1.ResourceAttributes{
			Group: "amd.com", Resource: "workspaces", Verb: "use", Name: "lab",
		},
	}
	if !reflect.DeepEqual(rec.spec, want) {
		t.Fatalf("spec = %#v", rec.spec)
	}
}

func TestCanUseWorkspaceRejectsAnEmptyName(t *testing.T) {
	rec := &recordingReviewer{}
	c := NewClient(rec, "primus:")
	ok, err := c.CanUseWorkspace(context.Background(), identity.Token{Subject: "u-1"}, "")
	if ok || !errors.Is(err, ErrEmptyWorkspace) || rec.calls != 0 {
		t.Fatalf("allowed=%v err=%v calls=%d", ok, err, rec.calls)
	}
}

func TestCanUseAllWorkspacesReviewsAnEmptyName(t *testing.T) {
	rec := &recordingReviewer{}
	c := NewClient(rec, "primus:")
	ok, err := c.CanUseAllWorkspaces(context.Background(), identity.Token{Subject: "u-1", Groups: []string{"team"}})
	if err != nil || !ok || rec.spec.ResourceAttributes == nil || rec.spec.ResourceAttributes.Name != "" || rec.spec.User != "primus:u-1" {
		t.Fatalf("allowed=%v err=%v spec=%#v", ok, err, rec.spec)
	}
}

func TestChooseWorkspaceRequiresAName(t *testing.T) {
	c := NewClient(&recordingReviewer{}, "primus:")
	if _, err := c.ChooseWorkspace(context.Background(), identity.Token{Subject: "u-1"}, ""); !errors.Is(err, ErrWorkspaceRequired) {
		t.Fatalf("err=%v", err)
	}
}
