// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import (
	"context"
	"errors"
	"testing"

	authorizationv1 "k8s.io/api/authorization/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"

	"sigs.k8s.io/agent-sandbox/pkg/authz"
)

// failingReviewer answers every review with an API error.
type failingReviewer struct{}

func (failingReviewer) Create(context.Context, *authorizationv1.SubjectAccessReview, metav1.CreateOptions) (*authorizationv1.SubjectAccessReview, error) {
	return nil, errors.New("apiserver down")
}

func TestMemberStillNeedsTheWorkspace(t *testing.T) {
	svc := New(Options{Authz: authz.NewClient(workspaceReviewer{allow: []string{"global-control-plane"}}, "primus:")})
	err := svc.checkWorkspaces(context.Background(), "user-1", nil, []string{"top-models"})
	if !IsReason(err, "user_not_in_workspace") {
		t.Fatalf("err=%v", err)
	}
}

func TestWorkspaceReviewErrorIsUnavailable(t *testing.T) {
	svc := New(Options{Authz: authz.NewClient(failingReviewer{}, "primus:")})
	err := svc.checkWorkspaces(context.Background(), "user-1", nil, []string{"top-models"})
	if !IsReason(err, "membership_unavailable") {
		t.Fatalf("err=%v", err)
	}
}
