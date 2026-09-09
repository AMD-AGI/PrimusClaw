// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build !linux

package envd

// countUserDescendants has no procfs implementation outside Linux.
func countUserDescendants(int) (int, error) { return 0, nil }
