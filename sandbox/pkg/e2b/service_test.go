// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package e2b

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/grant"
)

type fakeRunner struct {
	fail    error
	created []CreateRequest
	deleted []string
}

func (f *fakeRunner) Create(_ context.Context, req CreateRequest) (CreateResult, error) {
	f.created = append(f.created, req)
	if f.fail != nil {
		return CreateResult{}, f.fail
	}
	return CreateResult{SandboxName: "pod-" + req.SandboxID, Namespace: req.Namespace, PodIP: "10.0.0.8", PodPort: 8080}, nil
}

func (f *fakeRunner) Delete(_ context.Context, sandboxID string) error {
	f.deleted = append(f.deleted, sandboxID)
	return nil
}

type grantClaims struct {
	jwt.RegisteredClaims
	Workspaces        []string `json:"workspaces"`
	Kinds             []string `json:"kinds"`
	MaxGPUsPerSandbox int      `json:"maxGpusPerSandbox"`
}

func testPlane(t *testing.T, maxSec int64, perGPU []int32, maxSandboxes int32) (*Service, *fakeRunner, map[string]string) {
	t.Helper()
	now := time.Now().UTC().Truncate(time.Second)
	scheme := runtime.NewScheme()
	if err := runtimev1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	cl := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&runtimev1alpha1.SandboxGrant{}).Build()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	checker, err := grant.NewJWKSChecker(jwksFor(t, &priv.PublicKey))
	if err != nil {
		t.Fatal(err)
	}
	gs := grant.New(grant.Options{
		Client: cl, Namespace: "agent-sandbox-system", DataKey: bytes32(),
		Authn: allowAuth{}, Attest: checker, Identity: allowIdentity{}, Membership: allowMember{},
		Now: func() time.Time { return now },
	})
	req := grant.IssueRequest{
		GrantID:     "gr-01jb7m9k2x",
		Owner:       grant.OwnerRequest{UserID: "u-123", Workspaces: []string{"top-models"}},
		PlatformKey: "ak-test",
		Issuer:      grant.IssuerRequest{SessionID: "s-8f2a", AppRunID: "ar-01ja"},
		Roles: map[string]grant.RoleRequest{
			"measurement": {Templates: []string{"runner"}, MaxSandboxes: maxSandboxes, MaxGPUs: 128},
			"dev":         {Templates: []string{"runner"}, MaxSandboxes: maxSandboxes, MaxGPUs: 128},
		},
		Templates: []grant.TemplateRequest{{
			Name: "runner", PerGPUCount: perGPU,
			Spec: json.RawMessage(`{"acceptedEnvs":["FOO"],"inputs":["/in"],"outputs":["/out"]}`),
		}},
		MaxSandboxSeconds: maxSec,
		ExpiresAt:         now.Add(time.Hour),
	}
	req.Attestation = sign(t, priv, req)
	issued, _, err := gs.Issue(context.Background(), req)
	if err != nil {
		t.Fatal(err)
	}
	runner := &fakeRunner{}
	return New(Options{Grants: gs, Runner: runner, Namespace: "agent-sandbox-system"}), runner, issued.Keys
}

func bytes32() []byte {
	key := make([]byte, 32)
	for i := range key {
		key[i] = 'k'
	}
	return key
}

func jwksFor(t *testing.T, pub *ecdsa.PublicKey) []byte {
	t.Helper()
	x := base64.RawURLEncoding.EncodeToString(pub.X.FillBytes(make([]byte, 32)))
	y := base64.RawURLEncoding.EncodeToString(pub.Y.FillBytes(make([]byte, 32)))
	raw, err := json.Marshal(map[string]any{"keys": []map[string]string{{
		"kty": "EC", "crv": "P-256", "kid": "test", "alg": "ES256", "x": x, "y": y,
	}}})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func sign(t *testing.T, priv *ecdsa.PrivateKey, req grant.IssueRequest) string {
	t.Helper()
	token := jwt.NewWithClaims(jwt.SigningMethodES256, grantClaims{
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer: "primus-claw", Audience: jwt.ClaimStrings{"agent-sandbox-workload"},
			Subject: req.Owner.UserID, ID: req.GrantID,
			ExpiresAt: jwt.NewNumericDate(req.ExpiresAt), IssuedAt: jwt.NewNumericDate(req.ExpiresAt.Add(-time.Hour)),
		},
		Workspaces: req.Owner.Workspaces, Kinds: []string{"Sandbox"}, MaxGPUsPerSandbox: 8,
	})
	token.Header["kid"] = "test"
	signed, err := token.SignedString(priv)
	if err != nil {
		t.Fatal(err)
	}
	return signed
}

type allowAuth struct{}

func (allowAuth) Authenticate(context.Context, string) error { return nil }

type allowIdentity struct{}

func (allowIdentity) Check(context.Context, string, string) (string, error) { return "alice", nil }

type allowMember struct{}

func (allowMember) Check(context.Context, string, []string) error { return nil }

func TestCreateReplayKillAndQuota(t *testing.T) {
	svc, runner, keys := testPlane(t, 600, []int32{1}, 1)
	key := keys["measurement"]
	first, status, err := svc.Create(context.Background(), key, CreateBody{
		TemplateID: "runner", Timeout: 60,
		Metadata: map[string]string{"idempotency-key": "once", "agent-sandbox.io/team": "a"},
		EnvVars:  map[string]string{"FOO": "1"},
	})
	if err != nil || status != http.StatusCreated {
		t.Fatalf("status=%d err=%v", status, err)
	}
	if first.EnvdAccessToken == "" || first.ClientID != first.SandboxID || first.Domain != first.SandboxID || first.Alias != "runner" {
		t.Fatalf("first=%+v", first)
	}
	if first.TemplateID != "ar-01ja-runner-g1" || first.EnvdVersion != "0.1.0" {
		t.Fatalf("first=%+v", first)
	}
	created := runner.created[0]
	if len(runner.created) != 1 || created.Env["FOO"] != "1" || created.UserID != "u-123" ||
		created.Role != "measurement" || created.SessionID != "s-8f2a" || created.Workspace != "top-models" {
		t.Fatalf("created=%+v", runner.created)
	}
	second, status, err := svc.Create(context.Background(), key, CreateBody{
		TemplateID: "runner", Metadata: map[string]string{"idempotency-key": "once"},
	})
	if err != nil || status != http.StatusOK || second.SandboxID != first.SandboxID || second.EnvdAccessToken == "" {
		t.Fatalf("status=%d err=%v second=%+v", status, err, second)
	}
	connected, err := svc.Connect(context.Background(), key, first.SandboxID)
	if err != nil || connected.EnvdAccessToken == "" {
		t.Fatal(err)
	}
	for _, token := range []string{first.EnvdAccessToken, second.EnvdAccessToken, connected.EnvdAccessToken} {
		if _, err := svc.grants.LookupAccess(context.Background(), first.SandboxID, token); err != nil {
			t.Fatalf("token rejected after connect: %v", err)
		}
	}
	if len(runner.created) != 1 {
		t.Fatalf("replay created again: %d", len(runner.created))
	}
	listed, err := svc.List(context.Background(), key, "agent-sandbox.io/team=a", "", "", 0)
	if err != nil || len(listed.Sandboxes) != 1 || listed.Sandboxes[0].State != runtimev1alpha1.SandboxRunning {
		t.Fatalf("listed=%+v err=%v", listed, err)
	}
	if listed.Sandboxes[0].StartedAt == "" || listed.Sandboxes[0].Metadata["agent-sandbox.io/team"] != "a" {
		t.Fatalf("listed=%+v", listed.Sandboxes[0])
	}
	_, _, err = svc.Create(context.Background(), key, CreateBody{
		TemplateID: "runner", Metadata: map[string]string{"idempotency-key": "other"},
	})
	if !grant.IsReason(err, "grant_quota_exceeded") || !strings.HasPrefix(err.Error(), "grant_quota_exceeded") {
		t.Fatalf("err=%v", err)
	}
	other, err := svc.Get(context.Background(), keys["dev"], first.SandboxID)
	if other.SandboxID != "" || !grant.IsReason(err, "sandbox_not_found") {
		t.Fatalf("other=%+v err=%v", other, err)
	}
	if err := svc.Kill(context.Background(), key, first.SandboxID); err != nil {
		t.Fatal(err)
	}
	if err := svc.Kill(context.Background(), key, first.SandboxID); err != nil {
		t.Fatal(err)
	}
	if len(runner.deleted) != 1 {
		t.Fatalf("deleted=%v", runner.deleted)
	}
	got, err := svc.Get(context.Background(), key, first.SandboxID)
	if err != nil || got.State != runtimev1alpha1.SandboxEnded || got.CPUCount != 0 {
		t.Fatalf("got=%+v err=%v", got, err)
	}
	listed, err = svc.List(context.Background(), key, "", "", "", 0)
	if err != nil || len(listed.Sandboxes) != 0 {
		t.Fatalf("listed=%+v err=%v", listed, err)
	}
	_, _, err = svc.Create(context.Background(), key, CreateBody{
		TemplateID: "ar-01ja-runner-g1", Metadata: map[string]string{"idempotency-key": "once"},
	})
	if !grant.IsReason(err, "idempotency_key_spent") || !strings.Contains(err.Error(), first.SandboxID) {
		t.Fatalf("err=%v", err)
	}
	if _, err := svc.Connect(context.Background(), key, first.SandboxID); !grant.IsReason(err, "sandbox_not_found") {
		t.Fatalf("connect err=%v", err)
	}
}

func TestListFiltersHyperloomMetadata(t *testing.T) {
	svc, _, keys := testPlane(t, 600, []int32{1}, 4)
	key := keys["measurement"]
	for _, purpose := range []string{"measure", "other"} {
		_, _, err := svc.Create(context.Background(), key, CreateBody{
			TemplateID: "ar-01ja-runner-g1",
			Metadata: map[string]string{
				"idempotency-key":   purpose,
				"hyperloom.run-id":  "run-9",
				"hyperloom.purpose": purpose,
			},
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	listed, err := svc.List(context.Background(), key, "hyperloom.run-id=run-9&hyperloom.purpose=measure", "", "", 0)
	if err != nil || len(listed.Sandboxes) != 1 || listed.Sandboxes[0].Metadata["hyperloom.purpose"] != "measure" {
		t.Fatalf("listed=%+v err=%v", listed, err)
	}
}

func TestCreateRefusesMetadataEnvAndTimeout(t *testing.T) {
	svc, _, keys := testPlane(t, 600, []int32{1, 8}, 4)
	key := keys["measurement"]
	_, _, err := svc.Create(context.Background(), key, CreateBody{TemplateID: "runner", Metadata: map[string]string{"node-name": "n1"}})
	if !grant.IsReason(err, "metadata_reserved") {
		t.Fatalf("err=%v", err)
	}
	_, _, err = svc.Create(context.Background(), key, CreateBody{TemplateID: "runner", Metadata: map[string]string{"other": "x"}})
	if !grant.IsReason(err, "metadata_not_allowed") {
		t.Fatalf("err=%v", err)
	}
	_, _, err = svc.Create(context.Background(), key, CreateBody{TemplateID: "runner"})
	if !grant.IsReason(err, "template_not_allowed") {
		t.Fatalf("err=%v", err)
	}
	_, _, err = svc.Create(context.Background(), key, CreateBody{TemplateID: "ar-01ja-runner-g1", EnvVars: map[string]string{"BAR": "1"}})
	if !grant.IsReason(err, "env_not_allowed") {
		t.Fatalf("err=%v", err)
	}
	_, _, err = svc.Create(context.Background(), key, CreateBody{TemplateID: "ar-01ja-runner-g1", Timeout: 1000})
	if !grant.IsReason(err, "timeout_not_allowed") {
		t.Fatalf("err=%v", err)
	}
}

func TestCreateClampsDefaultTimeoutToGrant(t *testing.T) {
	svc, runner, keys := testPlane(t, 120, []int32{1}, 1)
	_, status, err := svc.Create(context.Background(), keys["measurement"], CreateBody{
		TemplateID: "ar-01ja-runner-g1",
	})
	if err != nil || status != http.StatusCreated {
		t.Fatalf("status=%d err=%v", status, err)
	}
	if len(runner.created) != 1 || runner.created[0].Timeout != 120*time.Second {
		t.Fatalf("created=%+v", runner.created)
	}
}

func TestTemplateMissingIsUnavailable(t *testing.T) {
	svc, runner, keys := testPlane(t, 0, []int32{1}, 2)
	runner.fail = ErrTemplateMissing
	_, _, err := svc.Create(context.Background(), keys["measurement"], CreateBody{TemplateID: "ar-01ja-runner-g1"})
	if !grant.IsReason(err, "template_unavailable") {
		t.Fatalf("err=%v", err)
	}
}

func TestQuotaMessageBody(t *testing.T) {
	gin.SetMode(gin.TestMode)
	svc, _, keys := testPlane(t, 600, []int32{1}, 1)
	h := NewHandler(svc)
	r := gin.New()
	h.Mount(r)
	body := []byte(`{"templateID":"ar-01ja-runner-g1","timeout":30}`)
	for i := 0; i < 2; i++ {
		w := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/sandboxes", bytes.NewReader(body))
		req.Header.Set("X-API-KEY", keys["measurement"])
		r.ServeHTTP(w, req)
		if i == 0 && w.Code != http.StatusCreated {
			t.Fatalf("first=%d %s", w.Code, w.Body.String())
		}
		if i == 1 {
			if w.Code != http.StatusTooManyRequests || !strings.Contains(w.Body.String(), `"message":"grant_quota_exceeded:`) {
				t.Fatalf("second=%d %s", w.Code, w.Body.String())
			}
		}
	}
	w := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/sandboxes", bytes.NewReader(body))
	r.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("missing key=%d %s", w.Code, w.Body.String())
	}
}

func TestSealedAllowsFilesOnly(t *testing.T) {
	if SealedAllows(http.MethodPost, "/api/execute", true, []string{"/in"}, []string{"/out"}) {
		t.Fatal("execute allowed")
	}
	if !SealedAllows(http.MethodGet, "/api/files?path=/in/a", true, []string{"/in"}, []string{"/out"}) {
		t.Fatal("input read denied")
	}
	if SealedAllows(http.MethodPut, "/api/files?path=/in/a", true, []string{"/in"}, []string{"/out"}) {
		t.Fatal("input write allowed")
	}
	if !SealedAllows(http.MethodPut, "/api/files/out/b", true, []string{"/in"}, []string{"/out"}) {
		t.Fatal("output write denied")
	}
	if SealedAllows(http.MethodPost, "/process.Process/Start", true, nil, nil) {
		t.Fatal("sealed process rpc")
	}
	for _, rawPath := range []string{
		"/api/session/create",
		"/api/session/s1/exec",
		"/api/terminal/t1/send_keys",
		"/api/jobs",
		"/health",
	} {
		if SealedAllows(http.MethodPost, rawPath, true, []string{"/in"}, []string{"/out"}) {
			t.Fatalf("sealed route allowed: %s", rawPath)
		}
	}
	if !SealedAllows(http.MethodPost, "/filesystem.Filesystem/Stat", true, []string{"/in"}, []string{"/out"}) {
		t.Fatal("filesystem rpc path is enforced in envd")
	}
	if !SealedFileAllows(http.MethodGet, "/in/a", []string{"/in"}, []string{"/out"}) {
		t.Fatal("read input")
	}
	if SealedFileAllows(http.MethodPost, "/in/a", []string{"/in"}, []string{"/out"}) {
		t.Fatal("write input")
	}
	for _, filePath := range []string{"/in/../secret", "/in/sub/../../secret"} {
		if SealedFileAllows(http.MethodGet, filePath, []string{"/in"}, []string{"/out"}) {
			t.Fatalf("traversal allowed: %s", filePath)
		}
		if SealedAllows(http.MethodGet, "/api/files?path="+url.QueryEscape(filePath), true, []string{"/in"}, []string{"/out"}) {
			t.Fatalf("HTTP traversal allowed: %s", filePath)
		}
	}
	if !SealedAllows(http.MethodPost, "/api/execute", false, nil, nil) {
		t.Fatal("unsealed denied")
	}
}

func TestListLimitAndMetadataLiterals(t *testing.T) {
	svc, _, keys := testPlane(t, 600, []int32{1}, 4)
	key := keys["measurement"]
	_, _, err := svc.Create(context.Background(), key, CreateBody{
		TemplateID: "ar-01ja-runner-g1",
		Metadata: map[string]string{
			"idempotency-key":  "plus",
			"hyperloom.run-id": "a+b",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	listed, err := svc.List(context.Background(), key, "hyperloom.run-id=a%2Bb", "", "", math.MaxInt)
	if err != nil || len(listed.Sandboxes) != 1 || listed.Sandboxes[0].Metadata["hyperloom.run-id"] != "a+b" {
		t.Fatalf("listed=%+v err=%v", listed, err)
	}
	listed, err = svc.List(context.Background(), key, "", "", encodeOffset(math.MaxInt), math.MaxInt)
	if err != nil || len(listed.Sandboxes) != 0 {
		t.Fatalf("listed=%+v err=%v", listed, err)
	}
	got, err := parseMetadataQuery("hyperloom.run-id=a%26b&hyperloom.purpose=a%3Db&note=a%25b")
	if err != nil || got["hyperloom.run-id"] != "a&b" || got["hyperloom.purpose"] != "a=b" || got["note"] != "a%b" {
		t.Fatalf("got=%v err=%v", got, err)
	}
}

func TestKillWithoutRunner(t *testing.T) {
	svc, _, keys := testPlane(t, 600, []int32{1}, 1)
	key := keys["measurement"]
	created, _, err := svc.Create(context.Background(), key, CreateBody{TemplateID: "ar-01ja-runner-g1", Timeout: 30})
	if err != nil {
		t.Fatal(err)
	}
	svc.runner = nil
	if err := svc.Kill(context.Background(), key, created.SandboxID); !grant.IsReason(err, "sandbox_unavailable") {
		t.Fatalf("err=%v", err)
	}
	got, err := svc.Get(context.Background(), key, created.SandboxID)
	if err != nil || got.State != runtimev1alpha1.SandboxRunning {
		t.Fatalf("got=%+v err=%v", got, err)
	}
}
