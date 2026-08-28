// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build linux

package egress

import (
	"fmt"
	"log/slog"
	"syscall"
)

// Linux capability constants.
const (
	capSetgid   = 6  // CAP_SETGID
	capNetAdmin = 12 // CAP_NET_ADMIN
	capNetRaw   = 13 // CAP_NET_RAW

	prCapBsetDrop = 24 // PR_CAPBSET_DROP
)

// DropNetCapabilities removes CAP_NET_ADMIN and CAP_NET_RAW from the process
// bounding set so that neither this process nor any child can regain them.
// Must be called after iptables setup is complete.
func DropNetCapabilities() error {
	for _, cap := range []struct {
		id   uintptr
		name string
	}{
		{capNetAdmin, "CAP_NET_ADMIN"},
		{capNetRaw, "CAP_NET_RAW"},
		{capSetgid, "CAP_SETGID"},
	} {
		if err := prctlCapBsetDrop(cap.id); err != nil {
			return fmt.Errorf("drop %s: %w", cap.name, err)
		}
		slog.Info("egress: dropped capability", "cap", cap.name)
	}
	return nil
}

// prctlCapBsetDrop uses AllThreadsSyscall6 to drop a capability from the
// bounding set on ALL OS threads. Plain Syscall6 is per-thread and would
// leave other Go scheduler threads (and their fork'd children) unaffected.
func prctlCapBsetDrop(capID uintptr) error {
	_, _, errno := syscall.AllThreadsSyscall6(
		syscall.SYS_PRCTL,
		prCapBsetDrop,
		capID,
		0, 0, 0, 0,
	)
	if errno != 0 {
		return fmt.Errorf("prctl(PR_CAPBSET_DROP, %d): %w", capID, errno)
	}
	return nil
}
