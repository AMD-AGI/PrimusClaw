// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package identity

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

const attestTimeout = 8 * time.Second

// Attester asks the identity provider to sign a short sandbox attestation.
type Attester struct {
	endpoint     string
	clientID     string
	clientSecret string
	http         *http.Client
}

// NewAttester calls endpoint with HTTP Basic client credentials.
func NewAttester(endpoint, clientID, clientSecret string) *Attester {
	return &Attester{
		endpoint:     strings.TrimRight(endpoint, "/"),
		clientID:     clientID,
		clientSecret: clientSecret,
		http:         &http.Client{Timeout: attestTimeout},
	}
}

// AttesterFromEnv reads IDENTITY_ATTEST_URL, IDENTITY_CLIENT_ID, and IDENTITY_CLIENT_SECRET.
// It returns nil when the URL is unset.
func AttesterFromEnv() (*Attester, error) {
	endpoint := strings.TrimSpace(os.Getenv("IDENTITY_ATTEST_URL"))
	if endpoint == "" {
		return nil, nil
	}
	id := strings.TrimSpace(os.Getenv("IDENTITY_CLIENT_ID"))
	secret := strings.TrimSpace(os.Getenv("IDENTITY_CLIENT_SECRET"))
	if id == "" || secret == "" {
		return nil, fmt.Errorf("IDENTITY_CLIENT_ID and IDENTITY_CLIENT_SECRET are required with IDENTITY_ATTEST_URL")
	}
	return NewAttester(endpoint, id, secret), nil
}

// Attest returns the compact attestation for the owner of subjectKey in workspace,
// bound to the Workload name sandbox and a GPU ceiling of maxGPUs.
func (a *Attester) Attest(ctx context.Context, subjectKey, workspace, sandbox string, maxGPUs int) (string, error) {
	if a == nil || a.endpoint == "" {
		return "", fmt.Errorf("identity attester is not configured")
	}
	body, err := json.Marshal(map[string]any{"subjectToken": subjectKey, "workspace": workspace, "sandbox": sandbox, "maxGpus": maxGPUs})
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, a.endpoint, bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.SetBasicAuth(a.clientID, a.clientSecret)
	req.Header.Set("Content-Type", "application/json")
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
		return "", fmt.Errorf("identity status %d", resp.StatusCode)
	}
	var out struct {
		Attestation string `json:"attestation"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("identity response: %w", err)
	}
	if out.Attestation == "" {
		return "", fmt.Errorf("identity response has no attestation")
	}
	return out.Attestation, nil
}
