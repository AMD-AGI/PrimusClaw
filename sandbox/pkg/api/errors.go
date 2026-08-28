// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Package api provides structured API errors for agent-sandbox.
package api

import (
	"errors"
)

var (
	// ErrCodeInterpreterNotFound indicates that the requested CodeInterpreter does not exist.
	ErrCodeInterpreterNotFound = errors.New("code interpreter not found")

	// ErrTemplateMissing indicates that the resource exists but has no pod template.
	ErrTemplateMissing = errors.New("resource has no pod template")

	// ErrPublicKeyMissing indicates that the Router public key is not yet available.
	ErrPublicKeyMissing = errors.New("public key not yet loaded from Router Secret")
)
