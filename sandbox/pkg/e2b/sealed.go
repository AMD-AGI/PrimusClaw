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
	// The token claim lists write roots: a caller may write a child of these paths and may not read them.
	HeaderInputs = "X-Sandbox-Inputs"
	// HeaderOutputs is a legacy request header. EnvD does not trust it.
	// The token claim lists read roots: a caller may read these paths and may not write them.
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
// Only file APIs are reachable. Reads must sit under outputs. Writes must sit
// strictly inside inputs, so the input root itself is not a file write.
// Filesystem RPC paths are checked from their request body.
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
	return sealedFileAllowed(method, filePath, inputs, outputs)
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
// Reads may use outputs, including the output root. Writes may use a child of
// an input root, not the root itself.
func SealedFileAllows(method, filePath string, inputs, outputs []string) bool {
	return sealedFileAllowed(method, filePath, inputs, outputs)
}

func sealedFileAllowed(method, filePath string, inputs, outputs []string) bool {
	switch method {
	case http.MethodGet, http.MethodHead:
		return pathAllowed(filePath, outputs)
	default:
		return pathInside(filePath, inputs)
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

// pathInside reports whether filePath is strictly below an allow root.
// The root itself is a directory, so writing it is not a file write.
func pathInside(filePath string, allow []string) bool {
	if filePath == "" {
		return false
	}
	cleaned := cleanPolicyPath(filePath)
	for _, item := range allow {
		if item == "" {
			continue
		}
		base := cleanPolicyPath(item)
		if base == "/" {
			return cleaned != "/"
		}
		if strings.HasPrefix(cleaned, base+"/") {
			return true
		}
	}
	return false
}

// cleanPolicyPath normalizes a caller path before allow-list comparison.
func cleanPolicyPath(value string) string {
	return path.Clean("/" + strings.TrimPrefix(value, "/"))
}
