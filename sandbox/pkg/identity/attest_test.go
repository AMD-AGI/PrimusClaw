// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package identity

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAttestUsesBasicClientCredentials(t *testing.T) {
	var gotUser, gotWorkspace, gotAuth string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, pass, ok := r.BasicAuth()
		if !ok || user != "svc-1" || pass != "secret" || r.URL.Path != "/api/v1/sandbox-attestations" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		var body struct {
			UserID    string `json:"userId"`
			Workspace string `json:"workspace"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		gotUser, gotWorkspace, gotAuth = body.UserID, body.Workspace, r.Header.Get("Authorization")
		_ = json.NewEncoder(w).Encode(map[string]string{"attestation": "eyJ.signed"})
	}))
	defer srv.Close()
	token, err := NewAttester(srv.URL+"/api/v1/sandbox-attestations", "svc-1", "secret").Attest(context.Background(), "user-1", "lab")
	if err != nil {
		t.Fatal(err)
	}
	if token != "eyJ.signed" || gotUser != "user-1" || gotWorkspace != "lab" || gotAuth == "" {
		t.Fatalf("token=%q user=%q workspace=%q auth=%q", token, gotUser, gotWorkspace, gotAuth)
	}
}

func TestAttestRejectsNonOK(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "no", http.StatusForbidden)
	}))
	defer srv.Close()
	if _, err := NewAttester(srv.URL, "svc-1", "secret").Attest(context.Background(), "user-1", "lab"); err == nil {
		t.Fatal("forbidden response was accepted")
	}
}

func TestAttesterFromEnv(t *testing.T) {
	t.Setenv("IDENTITY_ATTEST_URL", "")
	t.Setenv("IDENTITY_CLIENT_ID", "")
	t.Setenv("IDENTITY_CLIENT_SECRET", "")
	got, err := AttesterFromEnv()
	if err != nil || got != nil {
		t.Fatalf("unset: %+v %v", got, err)
	}
	t.Setenv("IDENTITY_ATTEST_URL", "http://identity.test/api/v1/sandbox-attestations")
	if _, err = AttesterFromEnv(); err == nil {
		t.Fatal("url without credentials was accepted")
	}
	t.Setenv("IDENTITY_CLIENT_ID", "svc-1")
	t.Setenv("IDENTITY_CLIENT_SECRET", "secret")
	got, err = AttesterFromEnv()
	if err != nil || got == nil || got.endpoint != "http://identity.test/api/v1/sandbox-attestations" {
		t.Fatalf("%+v %v", got, err)
	}
}
