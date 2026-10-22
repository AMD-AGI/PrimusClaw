// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package e2b

import (
	"net/http"
	"net/url"
	"strings"
)

// SealedAllows reports whether a sealed sandbox may serve this request.
// Process and execute paths are refused. File paths must sit under inputs
// for reads and outputs for writes. An empty allow-list refuses file access.
func SealedAllows(method, rawPath string, sealed bool, inputs, outputs []string) bool {
	if !sealed {
		return true
	}
	path := strings.ToLower(rawPath)
	if strings.Contains(path, "/execute") || strings.Contains(path, "/process") {
		return false
	}
	if !strings.Contains(path, "/file") {
		return true
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

func pathAllowed(filePath string, allow []string) bool {
	if filePath == "" {
		return false
	}
	for _, item := range allow {
		if item == "" {
			continue
		}
		base := strings.TrimRight(item, "/")
		if filePath == item || filePath == base || strings.HasPrefix(filePath, base+"/") {
			return true
		}
	}
	return false
}
