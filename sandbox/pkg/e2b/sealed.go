// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package e2b

import (
	"context"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/url"
	"path"
	"strings"

	"google.golang.org/protobuf/encoding/protowire"
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

// FilesystemReadRPC reports whether rawPath is a Stat or ListDir call.
// Those calls carry the target path in the body, not the URL.
func FilesystemReadRPC(rawPath string) bool {
	requestPath := rawPath
	if i := strings.IndexByte(requestPath, '?'); i >= 0 {
		requestPath = requestPath[:i]
	}
	return strings.HasSuffix(requestPath, "/filesystem.Filesystem/Stat") ||
		strings.HasSuffix(requestPath, "/filesystem.Filesystem/ListDir")
}

// SealedFilesystemRead reports whether a sealed Stat or ListDir may read the
// path in its body. Reads follow the output roots. A body without a path is refused.
func SealedFilesystemRead(contentType string, body []byte, inputs, outputs []string) bool {
	filePath, ok := filesystemReadPath(contentType, body)
	if !ok {
		return false
	}
	return sealedFileAllowed(http.MethodGet, filePath, inputs, outputs)
}

// filesystemReadPath reads the path field from a JSON or protobuf filesystem request.
func filesystemReadPath(contentType string, body []byte) (string, bool) {
	if strings.Contains(strings.ToLower(contentType), "json") {
		var raw struct {
			Path string `json:"path"`
		}
		if err := json.Unmarshal(body, &raw); err != nil {
			return "", false
		}
		return raw.Path, true
	}
	msg, ok := rpcMessage(contentType, body)
	if !ok {
		return "", false
	}
	return protoStringField(msg, 1)
}

// rpcMessage returns the protobuf message inside a Connect envelope, or the raw body.
func rpcMessage(contentType string, body []byte) ([]byte, bool) {
	ct := strings.ToLower(contentType)
	enveloped := strings.Contains(ct, "connect") || strings.Contains(ct, "grpc")
	if !enveloped && len(body) >= 5 {
		n := int(binary.BigEndian.Uint32(body[1:5]))
		enveloped = body[0]&1 == 0 && n == len(body)-5
	}
	if !enveloped {
		return body, true
	}
	if len(body) < 5 || body[0]&1 != 0 {
		return nil, false
	}
	n := int(binary.BigEndian.Uint32(body[1:5]))
	if n < 0 || 5+n > len(body) {
		return nil, false
	}
	return body[5 : 5+n], true
}

// protoStringField returns protobuf string field num.
// A message that parses and omits the field returns an empty path.
func protoStringField(msg []byte, want protowire.Number) (string, bool) {
	found := ""
	ok := true
	for len(msg) > 0 {
		num, typ, n := protowire.ConsumeTag(msg)
		if n < 0 {
			return "", false
		}
		msg = msg[n:]
		size := protowire.ConsumeFieldValue(num, typ, msg)
		if size < 0 {
			return "", false
		}
		if num == want && typ == protowire.BytesType {
			value, m := protowire.ConsumeString(msg)
			if m < 0 {
				return "", false
			}
			found = value
			ok = true
		}
		msg = msg[size:]
	}
	return found, ok
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
