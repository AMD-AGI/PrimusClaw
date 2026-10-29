// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import (
	"context"
	"net/http"
	"strings"

	authnv1 "k8s.io/api/authentication/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
)

// Authenticator checks the caller of the grant admin API.
type Authenticator interface {
	// Authenticate returns the Kubernetes username for a bearer token.
	Authenticate(ctx context.Context, token string) error
}

// TokenReviewAuthenticator accepts only the configured service-account usernames.
type TokenReviewAuthenticator struct {
	client  kubernetes.Interface
	allowed map[string]struct{}
}

// NewTokenReviewAuthenticator builds an authenticator. allowed entries are
// full usernames, such as system:serviceaccount:ns:name.
func NewTokenReviewAuthenticator(client kubernetes.Interface, allowed []string) *TokenReviewAuthenticator {
	set := make(map[string]struct{}, len(allowed))
	for _, name := range allowed {
		name = strings.TrimSpace(name)
		if name != "" {
			set[name] = struct{}{}
		}
	}
	return &TokenReviewAuthenticator{client: client, allowed: set}
}

// Authenticate reviews the token and requires an allowed username.
func (a *TokenReviewAuthenticator) Authenticate(ctx context.Context, token string) error {
	token = strings.TrimSpace(strings.TrimPrefix(token, "Bearer "))
	if token == "" {
		return opErr(http.StatusUnauthorized, "unauthenticated", "missing bearer token")
	}
	if len(a.allowed) == 0 {
		return opErr(http.StatusUnauthorized, "unauthenticated", "no grant callers are configured")
	}
	review, err := a.client.AuthenticationV1().TokenReviews().Create(ctx, &authnv1.TokenReview{
		Spec: authnv1.TokenReviewSpec{Token: token},
	}, metav1.CreateOptions{})
	if err != nil {
		return opWrap(http.StatusServiceUnavailable, "auth_unavailable", "token review failed", err)
	}
	if !review.Status.Authenticated {
		return opErr(http.StatusUnauthorized, "unauthenticated", "token was rejected")
	}
	if _, ok := a.allowed[review.Status.User.Username]; !ok {
		return opErr(http.StatusForbidden, "caller_not_allowed", review.Status.User.Username)
	}
	return nil
}
