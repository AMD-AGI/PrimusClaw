// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package e2b

import (
	"context"
	"net/http"
	"net/url"
	"path"
	"strings"
)

const (
	// HeaderSealed is a legacy request header. EnvD does not trust it.
	HeaderSealed = "X-Sandbox-Sealed"
	// HeaderInputs is a legacy request header. EnvD does not trust it.
	HeaderInputs = "X-Sandbox-Inputs"
	// HeaderOutputs is a legacy request header. EnvD does not trust it.
	HeaderOutputs = "X-Sandbox-Outputs"
)

// RequestPolicy is the sealed allow-list carried in a Router-signed token.
type RequestPolicy struct {
	Sealed  bool
	Inputs  []string
	Outputs []string
}

type requestPolicyKey struct{}

// WithRequestPolicy stores a verified sealed policy on the request context.
func WithRequestPolicy(ctx context.Context, policy RequestPolicy) context.Context {
	return context.WithValue(ctx, requestPolicyKey{}, policy)
}

// PolicyFrom returns the verified sealed policy. The bool is false when the
// request has no verified token.
func PolicyFrom(ctx context.Context) (RequestPolicy, bool) {
	policy, ok := ctx.Value(requestPolicyKey{}).(RequestPolicy)
	return policy, ok
}

// SealedAllows reports whether a sealed sandbox may serve this request.
// Only file APIs are reachable. File paths must sit under inputs for reads and
// outputs for writes. Filesystem RPC paths are checked from their request body.
func SealedAllows(method, rawPath string, sealed bool, inputs, outputs []string) bool {
	if !sealed {
		return true
	}
	requestPath := rawPath
	if i := strings.IndexByte(requestPath, '?'); i >= 0 {
		requestPath = requestPath[:i]
	}
	switch {
	case strings.HasPrefix(requestPath, "/filesystem.Filesystem/"):
		return true
	case requestPath != "/files" &&
		!strings.HasPrefix(requestPath, "/files/") &&
		requestPath != "/api/files" &&
		!strings.HasPrefix(requestPath, "/api/files/"):
		return false
	}
	filePath := filePathOf(rawPath)
	switch method {
	case http.MethodGet, http.MethodHead:
		return pathAllowed(filePath, inputs) || pathAllowed(filePath, outputs)
	default:
		return pathAllowed(filePath, outputs)
	}
}

func filePathOf(rawPath string) string {
	if i := strings.Index(rawPath, "?"); i >= 0 {
		q, err := url.ParseQuery(rawPath[i+1:])
		if err == nil && q.Get("path") != "" {
			return q.Get("path")
		}
		rawPath = rawPath[:i]
	}
	lower := strings.ToLower(rawPath)
	idx := strings.Index(lower, "/files")
	if idx < 0 {
		idx = strings.Index(lower, "/file")
	}
	if idx < 0 {
		return rawPath
	}
	rest := rawPath[idx:]
	if cut := strings.Index(strings.ToLower(rest), "/files"); cut >= 0 {
		rest = rest[cut+len("/files"):]
	}
	if rest == "" {
		return "/"
	}
	return rest
}

// SealedFileAllows reports whether a sealed sandbox may read or write filePath.
// Reads may use inputs or outputs. Writes may use outputs only.
func SealedFileAllows(method, filePath string, inputs, outputs []string) bool {
	switch method {
	case http.MethodGet, http.MethodHead:
		return pathAllowed(filePath, inputs) || pathAllowed(filePath, outputs)
	default:
		return pathAllowed(filePath, outputs)
	}
}

func pathAllowed(filePath string, allow []string) bool {
	if filePath == "" {
		return false
	}
	cleaned := cleanPolicyPath(filePath)
	for _, item := range allow {
		if item == "" {
			continue
		}
		base := cleanPolicyPath(item)
		if base == "/" || cleaned == base || strings.HasPrefix(cleaned, base+"/") {
			return true
		}
	}
	return false
}

// cleanPolicyPath normalizes a caller path before allow-list comparison.
func cleanPolicyPath(value string) string {
	return path.Clean("/" + strings.TrimPrefix(value, "/"))
}
