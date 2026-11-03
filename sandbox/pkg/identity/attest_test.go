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

func TestAttestExchangesTheKeyForAnAssertion(t *testing.T) {
	var form map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, pass, ok := r.BasicAuth()
		if !ok || user != "svc-1" || pass != "secret" || r.URL.Path != "/oauth/token" || r.ParseForm() != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		form = map[string]string{}
		for k := range r.PostForm {
			form[k] = r.PostForm.Get(k)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "eyJ.signed", "issued_token_type": tokenTypeJWT, "token_type": "N_A", "expires_in": 300})
	}))
	defer srv.Close()
	token, err := NewAttester(srv.URL+"/oauth/token", "svc-1", "secret", "aud-1", "detail-1").Attest(context.Background(), "ak-caller", "lab", "sbx-1", 2)
	if err != nil {
		t.Fatal(err)
	}
	if token != "eyJ.signed" || form["grant_type"] != grantTypeTokenExchange || form["subject_token"] != "ak-caller" ||
		form["subject_token_type"] != tokenTypeAccessToken || form["requested_token_type"] != tokenTypeJWT || form["audience"] != "aud-1" {
		t.Fatalf("token=%q form=%v", token, form)
	}
	var details []map[string]any
	if err := json.Unmarshal([]byte(form["authorization_details"]), &details); err != nil || len(details) != 1 {
		t.Fatalf("authorization_details=%q %v", form["authorization_details"], err)
	}
	d := details[0]
	if d["type"] != "detail-1" || d["workspace"] != "lab" || d["kind"] != "Sandbox" || d["name"] != "sbx-1" || d["gpus"] != float64(2) {
		t.Fatalf("detail=%v", d)
	}
}

func TestAttestRejectsNonOK(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"invalid_grant"}`, http.StatusBadRequest)
	}))
	defer srv.Close()
	if _, err := NewAttester(srv.URL, "svc-1", "secret", "a", "d").Attest(context.Background(), "ak-caller", "lab", "sbx-1", 0); err == nil {
		t.Fatal("an error response was accepted")
	}
}

func TestAttestRejectsAnAccessToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"access_token": "eyJ.at", "issued_token_type": tokenTypeAccessToken})
	}))
	defer srv.Close()
	if _, err := NewAttester(srv.URL, "svc-1", "secret", "a", "d").Attest(context.Background(), "ak-caller", "lab", "sbx-1", 0); err == nil {
		t.Fatal("an access token was accepted as the assertion")
	}
}

func TestAttesterFromEnv(t *testing.T) {
	t.Setenv("IDENTITY_TOKEN_URL", "")
	t.Setenv("IDENTITY_CLIENT_ID", "")
	t.Setenv("IDENTITY_CLIENT_SECRET", "")
	t.Setenv("IDENTITY_ASSERTION_AUDIENCE", "")
	t.Setenv("IDENTITY_ASSERTION_DETAIL_TYPE", "")
	got, err := AttesterFromEnv()
	if err != nil || got != nil {
		t.Fatalf("unset: %+v %v", got, err)
	}
	t.Setenv("IDENTITY_TOKEN_URL", "http://identity.test/oauth/token")
	if _, err = AttesterFromEnv(); err == nil {
		t.Fatal("url without credentials was accepted")
	}
	t.Setenv("IDENTITY_CLIENT_ID", "svc-1")
	t.Setenv("IDENTITY_CLIENT_SECRET", "secret")
	got, err = AttesterFromEnv()
	if err != nil || got == nil || got.endpoint != "http://identity.test/oauth/token" || got.audience != DefaultAssertionAudience || got.detailType != DefaultAssertionDetailType {
		t.Fatalf("%+v %v", got, err)
	}
	t.Setenv("IDENTITY_ASSERTION_AUDIENCE", "aud-2")
	t.Setenv("IDENTITY_ASSERTION_DETAIL_TYPE", "detail-2")
	if got, _ = AttesterFromEnv(); got.audience != "aud-2" || got.detailType != "detail-2" {
		t.Fatalf("%+v", got)
	}
}
