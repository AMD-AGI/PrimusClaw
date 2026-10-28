// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package router

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/grant"
	"sigs.k8s.io/agent-sandbox/pkg/store"
)

func TestParseClusterRoutes(t *testing.T) {
	routes, err := ParseClusterRoutes(" crusoe=https://example/crusoe/agent-sandbox ")
	if err != nil || routes["crusoe"] != "https://example/crusoe/agent-sandbox" {
		t.Fatalf("routes=%v err=%v", routes, err)
	}
	if _, err := ParseClusterRoutes("crusoe=not-a-url"); err == nil {
		t.Fatal("expected an invalid URL to be rejected")
	}
	empty, err := ParseClusterRoutes("")
	if err != nil || len(empty) != 0 {
		t.Fatalf("empty routes=%v err=%v", empty, err)
	}
}

func TestDataPlaneHopForwardsToClusterRouter(t *testing.T) {
	gin.SetMode(gin.TestMode)
	token := "sat-hop"
	globalJWT := mustJWT(t)
	crusoeJWT := mustJWT(t)

	var gotPath, gotAuth, gotAPIKey, gotAccess string
	envd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotAPIKey = r.Header.Get("X-API-KEY")
		gotAccess = r.Header.Get("X-Access-Token")
		_, _ = w.Write([]byte("from-envd"))
	}))
	defer envd.Close()

	crusoeStore := store.NewMemoryStore()
	if err := crusoeStore.StoreSandbox(context.Background(), &store.SandboxInfo{
		SessionID: "sbx-1", PodIP: envdHost(t, envd), PodPort: envdPort(t, envd),
	}); err != nil {
		t.Fatal(err)
	}
	crusoe := &Server{store: crusoeStore, jwt: crusoeJWT}
	crusoe.engine = gin.New()
	crusoe.engine.Any("/internal/v1/dataplane/:sandboxID/*proxyPath", crusoe.handleDataPlaneHop)
	if err := crusoe.ConfigureDataPlane("crusoe", "", string(mustPEM(t, globalJWT)), nil); err != nil {
		t.Fatal(err)
	}
	cluster := httptest.NewServer(crusoe.engine)
	defer cluster.Close()

	global := grantServer(t, token, "crusoe", false)
	global.jwt = globalJWT
	if err := global.ConfigureDataPlane("global", "crusoe="+cluster.URL, "", nil); err != nil {
		t.Fatal(err)
	}
	global.engine = gin.New()
	global.engine.Use(global.e2bAccessGate)

	front := httptest.NewServer(global.engine)
	defer front.Close()
	req, err := http.NewRequest(http.MethodPost, front.URL+"/api/execute?x=1", strings.NewReader("body"))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("E2b-Sandbox-Id", "sbx-1")
	req.Header.Set("X-Access-Token", token)
	req.Header.Set("X-API-KEY", "role-key")
	resp, err := front.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK || string(body) != "from-envd" {
		t.Fatalf("status=%d body=%s", resp.StatusCode, body)
	}
	if gotPath != "/api/execute" || gotAPIKey != "" || gotAccess != "" {
		t.Fatalf("path=%s api=%q access=%q", gotPath, gotAPIKey, gotAccess)
	}
	parsed, err := jwt.Parse(strings.TrimPrefix(gotAuth, "Bearer "), func(token *jwt.Token) (interface{}, error) {
		return crusoeJWT.PublicKey(), nil
	}, jwt.WithValidMethods([]string{"RS256"}), jwt.WithAudience(jwtAudience))
	if err != nil || !parsed.Valid {
		t.Fatalf("envd token: %v", err)
	}
	claims := parsed.Claims.(jwt.MapClaims)
	if claims["session_id"] != "sbx-1" {
		t.Fatalf("session_id=%v", claims["session_id"])
	}
}

func TestDataPlaneHopUsesPodFinderWhenStoreMisses(t *testing.T) {
	gin.SetMode(gin.TestMode)
	globalJWT := mustJWT(t)
	crusoeJWT := mustJWT(t)
	envd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	defer envd.Close()
	crusoe := &Server{store: store.NewMemoryStore(), jwt: crusoeJWT}
	crusoe.engine = gin.New()
	crusoe.engine.Any("/internal/v1/dataplane/:sandboxID/*proxyPath", crusoe.handleDataPlaneHop)
	if err := crusoe.ConfigureDataPlane("crusoe", "", string(mustPEM(t, globalJWT)), func(ctx context.Context, sandboxID string) (string, int, error) {
		if sandboxID != "sbx-1" {
			t.Fatalf("sandbox=%s", sandboxID)
		}
		return envdHost(t, envd), envdPort(t, envd), nil
	}); err != nil {
		t.Fatal(err)
	}
	token, err := globalJWT.GenerateHopToken("sbx-1", "crusoe")
	if err != nil {
		t.Fatal(err)
	}
	front := httptest.NewServer(crusoe.engine)
	defer front.Close()
	req, err := http.NewRequest(http.MethodGet, front.URL+"/internal/v1/dataplane/sbx-1/health", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := front.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("status=%d", resp.StatusCode)
	}
}

func TestDataPlaneHopRejectsOtherCluster(t *testing.T) {
	gin.SetMode(gin.TestMode)
	globalJWT := mustJWT(t)
	crusoe := &Server{jwt: mustJWT(t)}
	crusoe.engine = gin.New()
	crusoe.engine.Any("/internal/v1/dataplane/:sandboxID/*proxyPath", crusoe.handleDataPlaneHop)
	if err := crusoe.ConfigureDataPlane("crusoe", "", string(mustPEM(t, globalJWT)), nil); err != nil {
		t.Fatal(err)
	}
	token, err := globalJWT.GenerateHopToken("sbx-1", "other")
	if err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/internal/v1/dataplane/sbx-1/health", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	crusoe.engine.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status=%d", rec.Code)
	}
}

func TestSealedDenyDoesNotForward(t *testing.T) {
	gin.SetMode(gin.TestMode)
	token := "sat-sealed"
	hits := 0
	cluster := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		w.WriteHeader(http.StatusOK)
	}))
	defer cluster.Close()
	global := grantServer(t, token, "crusoe", true)
	global.jwt = mustJWT(t)
	if err := global.ConfigureDataPlane("global", "crusoe="+cluster.URL, "", nil); err != nil {
		t.Fatal(err)
	}
	global.engine = gin.New()
	global.engine.Use(global.e2bAccessGate)
	front := httptest.NewServer(global.engine)
	defer front.Close()
	req, err := http.NewRequest(http.MethodPost, front.URL+"/api/execute", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("E2b-Sandbox-Id", "sbx-1")
	req.Header.Set("X-Access-Token", token)
	resp, err := front.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden || hits != 0 {
		t.Fatalf("status=%d hits=%d", resp.StatusCode, hits)
	}
}

func TestDataPlaneEnvDPathReachesEnvD(t *testing.T) {
	gin.SetMode(gin.TestMode)
	globalJWT := mustJWT(t)
	var gotPath, gotAuth, gotSealedHeader string
	envd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotAuth = r.Header.Get("Authorization")
		gotSealedHeader = r.Header.Get("X-Sandbox-Sealed")
		w.WriteHeader(http.StatusNoContent)
	}))
	defer envd.Close()
	crusoe := &Server{store: store.NewMemoryStore(), jwt: mustJWT(t)}
	crusoe.engine = gin.New()
	crusoe.engine.Any("/files", crusoe.handleLocalEnvD)
	crusoe.engine.Any("/process.Process/*path", crusoe.handleLocalEnvD)
	if err := crusoe.ConfigureDataPlane("crusoe", "", string(mustPEM(t, globalJWT)), func(ctx context.Context, sandboxID string) (string, int, error) {
		return envdHost(t, envd), envdPort(t, envd), nil
	}); err != nil {
		t.Fatal(err)
	}
	sealedToken, err := globalJWT.generateHopToken("sbx-1", "crusoe", true, []string{"/in"}, []string{"/out"})
	if err != nil {
		t.Fatal(err)
	}
	openToken, err := globalJWT.generateHopToken("sbx-1", "crusoe", false, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	front := httptest.NewServer(crusoe.engine)
	defer front.Close()
	send := func(path, token string, want int) {
		t.Helper()
		req, err := http.NewRequest(http.MethodPost, front.URL+path, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Authorization", "Bearer "+token)
		resp, err := front.Client().Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != want || strings.Contains(string(body), "page not found") {
			t.Fatalf("%s status=%d body=%s", path, resp.StatusCode, body)
		}
	}
	send("/process.Process/Start", openToken, http.StatusNoContent)
	if gotPath != "/process.Process/Start" {
		t.Fatalf("path=%s", gotPath)
	}
	gotPath = ""
	send("/process.Process/Start", sealedToken, http.StatusForbidden)
	if gotPath != "" {
		t.Fatalf("sealed process call reached envd: %s", gotPath)
	}
	send("/files?path=/out/a", sealedToken, http.StatusForbidden)
	send("/files?path=/in/a", sealedToken, http.StatusNoContent)
	if gotPath != "/files" || gotSealedHeader != "" {
		t.Fatalf("path=%s sealedHeader=%s", gotPath, gotSealedHeader)
	}
	parsed, err := jwt.Parse(strings.TrimPrefix(gotAuth, "Bearer "), func(token *jwt.Token) (any, error) {
		return crusoe.jwt.publicKey, nil
	}, jwt.WithValidMethods([]string{"RS256"}))
	if err != nil || !parsed.Valid {
		t.Fatalf("envd token: %v", err)
	}
	claims, _ := parsed.Claims.(jwt.MapClaims)
	if claims["sealed"] != true || fmtClaim(claims["inputs"]) != "/in" || fmtClaim(claims["outputs"]) != "/out" {
		t.Fatalf("claims=%v", claims)
	}
}

func fmtClaim(v any) string {
	switch item := v.(type) {
	case string:
		return item
	case []any:
		parts := make([]string, 0, len(item))
		for _, one := range item {
			parts = append(parts, fmt.Sprint(one))
		}
		return strings.Join(parts, ",")
	default:
		return ""
	}
}

func grantServer(t *testing.T, token, cluster string, sealed bool) *Server {
	t.Helper()
	scheme := runtime.NewScheme()
	if err := runtimev1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	cl := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&runtimev1alpha1.SandboxGrant{}).Build()
	g := &runtimev1alpha1.SandboxGrant{ObjectMeta: metav1.ObjectMeta{Name: "gr-1", Namespace: "ns"}}
	if err := cl.Create(context.Background(), g); err != nil {
		t.Fatal(err)
	}
	g.Status.Sandboxes = []runtimev1alpha1.GrantSandboxRef{{
		ID: "sbx-1", Role: "measurement", State: runtimev1alpha1.SandboxRunning,
		AccessTokenHash: grant.HashKey(token), Cluster: cluster, Sealed: sealed,
		Inputs: []string{"/in"}, Outputs: []string{"/out"},
	}}
	if err := cl.Status().Update(context.Background(), g); err != nil {
		t.Fatal(err)
	}
	return &Server{grants: grant.New(grant.Options{Client: cl, Namespace: "ns", Now: time.Now})}
}

func mustJWT(t *testing.T) *JWTManager {
	t.Helper()
	mgr, err := NewJWTManager(nil)
	if err != nil {
		t.Fatal(err)
	}
	return mgr
}

func mustPEM(t *testing.T, mgr *JWTManager) []byte {
	t.Helper()
	pem, err := mgr.GetPublicKeyPEM()
	if err != nil {
		t.Fatal(err)
	}
	return pem
}

func envdHost(t *testing.T, srv *httptest.Server) string {
	t.Helper()
	return strings.Split(strings.TrimPrefix(srv.URL, "http://"), ":")[0]
}

func envdPort(t *testing.T, srv *httptest.Server) int {
	t.Helper()
	var port int
	if _, err := fmtSscanf(strings.Split(strings.TrimPrefix(srv.URL, "http://"), ":")[1], &port); err != nil {
		t.Fatal(err)
	}
	return port
}

func fmtSscanf(raw string, port *int) (int, error) {
	n := 0
	for _, c := range raw {
		if c < '0' || c > '9' {
			return 0, errNotPort
		}
		n = n*10 + int(c-'0')
	}
	*port = n
	return 1, nil
}

var errNotPort = errString("not a port")

type errString string

func (e errString) Error() string { return string(e) }
