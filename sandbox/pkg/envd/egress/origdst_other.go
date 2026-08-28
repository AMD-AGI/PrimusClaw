// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build !linux

package egress

import (
	"fmt"
	"net"
)

// GetOriginalDst is not supported on non-Linux platforms.
func GetOriginalDst(conn net.Conn) (net.IP, int, error) {
	return nil, 0, fmt.Errorf("SO_ORIGINAL_DST not supported on this platform")
}
