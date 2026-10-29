// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Package grant stores Claw-issued sandbox grants as SandboxGrant CRs and
// enforces their quota. Claw remains the authority; this package is the
// execution copy used on the create path.
package grant

import "fmt"

// OpError is a grant operation failure with an HTTP status and a stable reason.
type OpError struct {
	Status  int
	Reason  string
	Detail  string
	wrapped error
}

// Error returns reason and detail. The detail must not contain secrets.
func (e *OpError) Error() string {
	if e.Detail == "" {
		return e.Reason
	}
	return e.Reason + ": " + e.Detail
}

// Unwrap returns the underlying error, if any.
func (e *OpError) Unwrap() error { return e.wrapped }

func opErr(status int, reason, detail string) *OpError {
	return &OpError{Status: status, Reason: reason, Detail: detail}
}

// Op returns an operation error whose message starts with the reason.
func Op(status int, reason, detail string) *OpError {
	return opErr(status, reason, detail)
}

func opWrap(status int, reason, detail string, err error) *OpError {
	if detail == "" && err != nil {
		detail = err.Error()
	}
	return &OpError{Status: status, Reason: reason, Detail: detail, wrapped: err}
}

// Message is the E2B-style body text: reason first, then the detail.
func (e *OpError) Message() string {
	return e.Error()
}

// IsReason reports whether err is an OpError with the given reason.
func IsReason(err error, reason string) bool {
	oe, ok := err.(*OpError)
	return ok && oe.Reason == reason
}

func fmtDetail(format string, args ...any) string {
	return fmt.Sprintf(format, args...)
}
