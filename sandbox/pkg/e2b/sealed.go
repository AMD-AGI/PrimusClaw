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
		!strings.HasPrefix(requestPath, "/files/"):
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

// FilesystemRPC reports whether rawPath is a filesystem RPC.
// Those calls carry the target path in the body, not the URL.
func FilesystemRPC(rawPath string) bool {
	_, ok := filesystemMethod(rawPath)
	return ok
}

// filesystemMethod returns the RPC name after the filesystem service prefix.
func filesystemMethod(rawPath string) (string, bool) {
	requestPath := rawPath
	if i := strings.IndexByte(requestPath, '?'); i >= 0 {
		requestPath = requestPath[:i]
	}
	const service = "/filesystem.Filesystem/"
	i := strings.LastIndex(requestPath, service)
	if i < 0 {
		return "", false
	}
	return requestPath[i+len(service):], true
}

// SealedFilesystemRead reports whether a sealed Stat or ListDir may read the
// path in its body. Reads follow the output roots. A body without a path is refused.
func SealedFilesystemRead(contentType string, body []byte, inputs, outputs []string) bool {
	paths, ok := filesystemPaths(contentType, body, []string{"path"})
	if !ok {
		return false
	}
	return sealedFileAllowed(http.MethodGet, paths[0], inputs, outputs)
}

// SealedFilesystemCall reports whether a sealed sandbox may make this filesystem RPC.
// Stat and ListDir follow the read rule. MakeDir and Remove follow the write
// rule, and Move applies it to both source and destination. Other RPCs are refused.
func SealedFilesystemCall(rawPath, contentType string, body []byte, inputs, outputs []string) bool {
	method, _ := filesystemMethod(rawPath)
	switch method {
	case "Stat", "ListDir":
		return SealedFilesystemRead(contentType, body, inputs, outputs)
	case "MakeDir", "Remove":
		paths, ok := filesystemPaths(contentType, body, []string{"path"})
		return ok && sealedFileAllowed(http.MethodPost, paths[0], inputs, outputs)
	case "Move":
		paths, ok := filesystemPaths(contentType, body, []string{"source", "destination"})
		return ok && sealedFileAllowed(http.MethodPost, paths[0], inputs, outputs) &&
			sealedFileAllowed(http.MethodPost, paths[1], inputs, outputs)
	default:
		return false
	}
}

// filesystemPaths reads the named string fields from a JSON or protobuf request.
// Protobuf field numbers follow the order of names, starting at 1.
func filesystemPaths(contentType string, body []byte, names []string) ([]string, bool) {
	out := make([]string, len(names))
	if strings.Contains(strings.ToLower(contentType), "json") {
		var raw map[string]any
		if err := json.Unmarshal(body, &raw); err != nil {
			return nil, false
		}
		for i, name := range names {
			value, _ := raw[name].(string)
			out[i] = value
		}
		return out, true
	}
	msg, ok := rpcMessage(contentType, body)
	if !ok {
		return nil, false
	}
	for i := range names {
		value, ok := protoStringField(msg, protowire.Number(i+1))
		if !ok {
			return nil, false
		}
		out[i] = value
	}
	return out, true
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
