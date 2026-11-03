// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package identity

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

const (
	attestTimeout = 8 * time.Second

	grantTypeTokenExchange = "urn:ietf:params:oauth:grant-type:token-exchange"
	tokenTypeAccessToken   = "urn:ietf:params:oauth:token-type:access_token"
	tokenTypeJWT           = "urn:ietf:params:oauth:token-type:jwt"

	// DefaultAssertionAudience is the aud the admission constraint expects.
	DefaultAssertionAudience = "agent-sandbox-admission"
	// DefaultAssertionDetailType is the authorization_details type that binds the assertion to a Workload.
	DefaultAssertionDetailType = "agent-sandbox-workload"
	// workloadKind is the Workload kind the control plane creates.
	workloadKind = "Sandbox"
)

// Attester exchanges the caller's identity key for a short identity provider assertion
// (RFC 8693, requested_token_type jwt) bound to one Workload by authorization_details (RFC 9396).
type Attester struct {
	endpoint     string
	clientID     string
	clientSecret string
	audience     string
	detailType   string
	http         *http.Client
}

// NewAttester calls the token endpoint with HTTP Basic client credentials and asks for
// assertions for audience with authorization details of detailType.
func NewAttester(endpoint, clientID, clientSecret, audience, detailType string) *Attester {
	return &Attester{
		endpoint:     strings.TrimRight(endpoint, "/"),
		clientID:     clientID,
		clientSecret: clientSecret,
		audience:     audience,
		detailType:   detailType,
		http:         &http.Client{Timeout: attestTimeout},
	}
}

// AttesterFromEnv reads IDENTITY_TOKEN_URL, IDENTITY_CLIENT_ID, IDENTITY_CLIENT_SECRET,
// IDENTITY_ASSERTION_AUDIENCE, and IDENTITY_ASSERTION_DETAIL_TYPE. It returns nil when the URL is unset.
func AttesterFromEnv() (*Attester, error) {
	endpoint := strings.TrimSpace(os.Getenv("IDENTITY_TOKEN_URL"))
	if endpoint == "" {
		return nil, nil
	}
	id := strings.TrimSpace(os.Getenv("IDENTITY_CLIENT_ID"))
	secret := strings.TrimSpace(os.Getenv("IDENTITY_CLIENT_SECRET"))
	if id == "" || secret == "" {
		return nil, fmt.Errorf("IDENTITY_CLIENT_ID and IDENTITY_CLIENT_SECRET are required with IDENTITY_TOKEN_URL")
	}
	audience := strings.TrimSpace(os.Getenv("IDENTITY_ASSERTION_AUDIENCE"))
	if audience == "" {
		audience = DefaultAssertionAudience
	}
	detailType := strings.TrimSpace(os.Getenv("IDENTITY_ASSERTION_DETAIL_TYPE"))
	if detailType == "" {
		detailType = DefaultAssertionDetailType
	}
	return NewAttester(endpoint, id, secret, audience, detailType), nil
}

// Attest returns the assertion for the owner of subjectKey, bound to workspace, the Workload name
// sandbox, and the Workload GPU total gpus.
func (a *Attester) Attest(ctx context.Context, subjectKey, workspace, sandbox string, gpus int) (string, error) {
	if a == nil || a.endpoint == "" {
		return "", fmt.Errorf("identity attester is not configured")
	}
	details, err := json.Marshal([]map[string]any{{
		"type": a.detailType, "workspace": workspace, "kind": workloadKind, "name": sandbox, "gpus": gpus,
	}})
	if err != nil {
		return "", err
	}
	form := url.Values{
		"grant_type":            {grantTypeTokenExchange},
		"subject_token":         {subjectKey},
		"subject_token_type":    {tokenTypeAccessToken},
		"requested_token_type":  {tokenTypeJWT},
		"audience":              {a.audience},
		"authorization_details": {string(details)},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.SetBasicAuth(a.clientID, a.clientSecret)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	resp, err := a.http.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes))
	if err != nil {
		return "", err
	}
	if resp.StatusCode != http.StatusOK {
		var oerr struct {
			Error string `json:"error"`
		}
		_ = json.Unmarshal(raw, &oerr)
		return "", fmt.Errorf("identity status %d %s", resp.StatusCode, oerr.Error)
	}
	var out struct {
		AccessToken     string `json:"access_token"`
		IssuedTokenType string `json:"issued_token_type"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("identity response: %w", err)
	}
	if out.IssuedTokenType != tokenTypeJWT || out.AccessToken == "" {
		return "", fmt.Errorf("identity response has no assertion")
	}
	return out.AccessToken, nil
}
