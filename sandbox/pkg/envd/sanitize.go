// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package envd

import (
	"fmt"
	"path/filepath"
	"strings"
)

// sanitizePath ensures that the given path stays within the workspace root.
// It resolves the absolute path and checks that it is a subdirectory of root.
// Returns the cleaned absolute path or an error if the path escapes root.
func sanitizePath(root, relPath string) (string, error) {
	if relPath == "" {
		return root, nil
	}

	// Clean and join
	joined := filepath.Join(root, relPath)

	// Resolve to absolute (handles . and ..)
	abs, err := filepath.Abs(joined)
	if err != nil {
		return "", fmt.Errorf("invalid path: %w", err)
	}

	// Ensure abs is within root
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", fmt.Errorf("invalid root: %w", err)
	}

	if !strings.HasPrefix(abs, rootAbs+string(filepath.Separator)) && abs != rootAbs {
		return "", fmt.Errorf("path %q escapes workspace root", relPath)
	}

	return abs, nil
}
