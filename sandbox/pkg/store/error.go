// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Package store — sentinel errors.
package store

import "errors"

// ErrNotFound is returned when a session is not found in the store.
// Use errors.Is(err, store.ErrNotFound) to check.
var ErrNotFound = errors.New("store: not found")
