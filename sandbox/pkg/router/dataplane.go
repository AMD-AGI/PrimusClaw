// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package router

import (
	"context"
	"crypto/rsa"
	"errors"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
	"sigs.k8s.io/agent-sandbox/pkg/e2b"
	log "sigs.k8s.io/agent-sandbox/pkg/logx"
	"sigs.k8s.io/agent-sandbox/pkg/store"
)

const (
	// EnvClusterID is this control plane's SaFE cluster id.
	// A hop token whose cluster claim differs is rejected.
	EnvClusterID = "SANDBOX_CLUSTER_ID"
	// EnvClusterRoutes lists remote cluster id to Router base URL pairs,
	// separated by commas: crusoe=https://example/crusoe/agent-sandbox
	EnvClusterRoutes = "SANDBOX_CLUSTER_ROUTES"
	// EnvUpstreamPublicKey is the managing Router's public PEM.
	// Empty disables the hop receiver.
	EnvUpstreamPublicKey = "SANDBOX_UPSTREAM_PUBLIC_KEY"
)

// PodAddressFunc resolves a sandbox id to an envd address in this cluster.
// The session store is tried first. This runs when that store has no pod IP,
// which is the case for a SaFE Workload that is not a Sandbox CR.
type PodAddressFunc func(ctx context.Context, sandboxID string) (ip string, port int, err error)

// dataPlane is the optional hop between the managing Router and a cluster Router.
type dataPlane struct {
	clusterID string
	routes    map[string]string
	upstream  *rsa.PublicKey
	pods      PodAddressFunc
}

// ConfigureDataPlane installs the cluster table and the key that verifies hop tokens.
// An empty route table keeps every sandbox on this Router.
func (s *Server) ConfigureDataPlane(clusterID, routesRaw, upstreamPEM string, pods PodAddressFunc) error {
	routes, err := ParseClusterRoutes(routesRaw)
	if err != nil {
		return err
	}
	var pub *rsa.PublicKey
	if strings.TrimSpace(upstreamPEM) != "" {
		pub, err = parsePublicKeyPEM([]byte(upstreamPEM))
		if err != nil {
			return err
		}
	}
	s.dp = dataPlane{
		clusterID: strings.TrimSpace(clusterID),
		routes:    routes,
		upstream:  pub,
		pods:      pods,
	}
	return nil
}

// ParseClusterRoutes parses "id=url" pairs. An empty string is an empty table.
func ParseClusterRoutes(raw string) (map[string]string, error) {
	out := map[string]string{}
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return out, nil
	}
	for _, item := range strings.Split(raw, ",") {
		item = strings.TrimSpace(item)
		if item == "" {
			continue
		}
		id, base, ok := strings.Cut(item, "=")
		id = strings.TrimSpace(id)
		base = strings.TrimRight(strings.TrimSpace(base), "/")
		if !ok || id == "" || base == "" {
			return nil, errors.New("cluster route must be id=url")
		}
		u, err := url.Parse(base)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return nil, errors.New("cluster route URL must be http or https")
		}
		out[id] = base
	}
	return out, nil
}

// forwardTarget reports the Router base URL for a sandbox that lives on another cluster.
func (s *Server) forwardTarget(cluster string) (string, bool) {
	if cluster == "" || cluster == s.dp.clusterID {
		return "", false
	}
	base, ok := s.dp.routes[cluster]
	return base, ok && base != ""
}

// forwardDataPlane sends an already-authorized data-plane request to the cluster Router.
// The E2B credentials are removed. The hop token is the only credential on the next hop.
func (s *Server) forwardDataPlane(c *gin.Context, sandboxID, base string, ref runtimev1alpha1.GrantSandboxRef) {
	if s.jwt == nil {
		writeGate(c, http.StatusServiceUnavailable, "sandbox_unavailable", "sandbox authentication unavailable")
		return
	}
	cluster := ref.Cluster
	token, err := s.jwt.generateHopToken(sandboxID, cluster, ref.Sealed, ref.Inputs, ref.Outputs)
	if err != nil {
		log.Error("dataplane: failed to sign hop token", "error", err, "sandbox", sandboxID, "cluster", cluster)
		writeGate(c, http.StatusServiceUnavailable, "sandbox_unavailable", "sandbox authentication unavailable")
		return
	}
	target, err := hopURL(base, sandboxID, c.Request.URL.Path, c.Request.URL.RawQuery)
	if err != nil {
		writeGate(c, http.StatusBadGateway, "sandbox_unavailable", "cluster route is invalid")
		return
	}
	proxy := &httputil.ReverseProxy{
		FlushInterval: -1,
		Director: func(req *http.Request) {
			req.URL = target
			req.Host = target.Host
			req.Header.Del("X-API-KEY")
			req.Header.Del("X-Access-Token")
			req.Header.Del(e2b.HeaderSealed)
			req.Header.Del(e2b.HeaderInputs)
			req.Header.Del(e2b.HeaderOutputs)
			req.Header.Set("Authorization", "Bearer "+token)
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			log.Error("dataplane: cluster router unreachable", "cluster", cluster, "error", err)
			if gw, ok := w.(gin.ResponseWriter); ok && gw.Written() {
				return
			}
			http.Error(w, "sandbox_unavailable: cluster router unreachable", http.StatusBadGateway)
		},
	}
	proxy.ServeHTTP(c.Writer, c.Request)
}

// hopURL builds the receiving Router's path for one sandbox request.
func hopURL(base, sandboxID, rawPath, rawQuery string) (*url.URL, error) {
	u, err := url.Parse(base)
	if err != nil {
		return nil, err
	}
	if rawPath == "" {
		rawPath = "/"
	}
	u.Path = strings.TrimRight(u.Path, "/") + "/internal/v1/dataplane/" + url.PathEscape(sandboxID) + rawPath
	u.RawQuery = rawQuery
	return u, nil
}

// handleDataPlaneHop accepts a hop from the managing Router and proxies it to envd.
// It does not forward again. A token for another cluster is rejected.
func (s *Server) handleDataPlaneHop(c *gin.Context) {
	sandboxID := c.Param("sandboxID")
	if s.dp.upstream == nil || s.dp.clusterID == "" {
		writeGate(c, http.StatusServiceUnavailable, "sandbox_unavailable", "dataplane hop is not configured")
		return
	}
	raw := bearerToken(c.GetHeader("Authorization"))
	ref, err := verifyHopToken(s.dp.upstream, raw, sandboxID, s.dp.clusterID)
	if err != nil {
		writeGate(c, http.StatusUnauthorized, "invalid_token", "hop token is not valid for this cluster")
		return
	}
	info, err := s.localSandbox(c.Request.Context(), sandboxID)
	if err != nil || info == nil || info.PodIP == "" {
		writeGate(c, http.StatusBadGateway, "sandbox_unavailable", sandboxID)
		return
	}
	suffix := c.Param("proxyPath")
	if suffix == "" {
		suffix = "/"
	}
	if !hopSealedAllows(c, suffix, ref) {
		return
	}
	c.Request.URL.Path = suffix
	c.Request.URL.RawPath = ""
	c.Request.RequestURI = suffix
	if c.Request.URL.RawQuery != "" {
		c.Request.RequestURI += "?" + c.Request.URL.RawQuery
	}
	c.Request.Header.Set("E2b-Sandbox-Id", sandboxID)
	s.proxyEnvD(c, info, ref)
}

// handleLocalEnvD proxies an envd path that reached this Router without the hop prefix.
// The hop token still names the sandbox. A missing token is not a data-plane call.
func (s *Server) handleLocalEnvD(c *gin.Context) {
	if s.dp.upstream == nil || s.dp.clusterID == "" {
		writeGate(c, http.StatusNotFound, "sandbox_not_found", "dataplane hop is not configured")
		return
	}
	raw := bearerToken(c.GetHeader("Authorization"))
	ref, err := verifyHopToken(s.dp.upstream, raw, "", s.dp.clusterID)
	if err != nil || ref.ID == "" {
		writeGate(c, http.StatusUnauthorized, "invalid_token", "hop token is not valid for this cluster")
		return
	}
	if !hopSealedAllows(c, c.Request.URL.Path, ref) {
		return
	}
	info, err := s.localSandbox(c.Request.Context(), ref.ID)
	if err != nil || info == nil || info.PodIP == "" {
		writeGate(c, http.StatusBadGateway, "sandbox_unavailable", ref.ID)
		return
	}
	c.Request.Header.Set("E2b-Sandbox-Id", ref.ID)
	s.proxyEnvD(c, info, ref)
}

// hopSealedAllows applies the sealed allow-list carried by a verified hop token
// to the envd path. A denied request is answered with 403.
func hopSealedAllows(c *gin.Context, path string, ref runtimev1alpha1.GrantSandboxRef) bool {
	rawPath := path
	if c.Request.URL.RawQuery != "" {
		rawPath += "?" + c.Request.URL.RawQuery
	}
	if !e2b.SealedAllows(c.Request.Method, rawPath, ref.Sealed, ref.Inputs, ref.Outputs) {
		writeGate(c, http.StatusForbidden, "sealed_denied", "path is outside the sealed allow-list")
		return false
	}
	if ref.Sealed && e2b.FilesystemReadRPC(path) && !sealedFilesystemRead(c, ref) {
		return false
	}
	return true
}

// envdProxyPath strips a hop prefix so envd sees /files or /process.Process/Start.
func envdProxyPath(path string) string {
	const marker = "/internal/v1/dataplane/"
	i := strings.Index(path, marker)
	if i < 0 {
		if path == "" {
			return "/"
		}
		return path
	}
	rest := path[i+len(marker):]
	slash := strings.Index(rest, "/")
	if slash < 0 {
		return "/"
	}
	return rest[slash:]
}

// localSandbox finds the envd address in this cluster.
// The session store wins. A SaFE Workload that has no Sandbox record falls through to pods.
func (s *Server) localSandbox(ctx context.Context, sandboxID string) (*store.SandboxInfo, error) {
	if s.store != nil {
		info, err := s.store.GetSandboxBySessionID(ctx, sandboxID)
		if err == nil && info != nil && info.PodIP != "" {
			return info, nil
		}
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			return nil, err
		}
	}
	if s.dp.pods == nil {
		return nil, store.ErrNotFound
	}
	ip, port, err := s.dp.pods(ctx, sandboxID)
	if err != nil {
		return nil, err
	}
	return &store.SandboxInfo{SessionID: sandboxID, PodIP: ip, PodPort: port}, nil
}

func bearerToken(header string) string {
	parts := strings.SplitN(header, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return ""
	}
	return strings.TrimSpace(parts[1])
}

// verifyHopToken checks the managing Router's signature, audience, sandbox id, and cluster.
// An empty sandboxID accepts the id carried in the token, which is how an envd
// path with no id in the URL is routed.
func verifyHopToken(pub *rsa.PublicKey, raw, sandboxID, cluster string) (runtimev1alpha1.GrantSandboxRef, error) {
	if pub == nil || raw == "" {
		return runtimev1alpha1.GrantSandboxRef{}, errors.New("missing hop token")
	}
	token, err := jwt.Parse(raw, func(token *jwt.Token) (interface{}, error) {
		return pub, nil
	},
		jwt.WithValidMethods([]string{"RS256"}),
		jwt.WithIssuer(jwtIssuer),
		jwt.WithAudience(hopAudience),
		jwt.WithExpirationRequired(),
		jwt.WithIssuedAt(),
		jwt.WithLeeway(5*time.Second),
	)
	if err != nil || !token.Valid {
		return runtimev1alpha1.GrantSandboxRef{}, errors.New("invalid hop token")
	}
	claims, ok := token.Claims.(jwt.MapClaims)
	if !ok {
		return runtimev1alpha1.GrantSandboxRef{}, errors.New("invalid hop token")
	}
	gotSandbox, _ := claims["sandbox_id"].(string)
	gotCluster, _ := claims["cluster"].(string)
	if gotSandbox == "" || gotCluster != cluster || (sandboxID != "" && gotSandbox != sandboxID) {
		return runtimev1alpha1.GrantSandboxRef{}, errors.New("hop token does not match this sandbox")
	}
	ref := runtimev1alpha1.GrantSandboxRef{ID: gotSandbox}
	if sealed, _ := claims["sealed"].(bool); sealed {
		ref.Sealed = true
		ref.Inputs = splitClaim(claims["inputs"])
		ref.Outputs = splitClaim(claims["outputs"])
	}
	return ref, nil
}

func splitClaim(v any) []string {
	s, _ := v.(string)
	if s == "" {
		return nil
	}
	return strings.Split(s, "\n")
}
