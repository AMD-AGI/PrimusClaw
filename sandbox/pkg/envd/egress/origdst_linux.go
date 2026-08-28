// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

//go:build linux

package egress

import (
	"encoding/binary"
	"fmt"
	"net"
	"syscall"
	"unsafe"
)

// SO_ORIGINAL_DST retrieves the original destination address of a redirected
// TCP connection (set by iptables -j REDIRECT). Linux only.
const (
	soOriginalDst     = 80 // SO_ORIGINAL_DST for IPv4
	soOriginalDstIPv6 = 80 // IP6T_SO_ORIGINAL_DST
)

// GetOriginalDst returns the original destination (IP, port) of a TCP
// connection that was redirected by iptables REDIRECT rule.
func GetOriginalDst(conn net.Conn) (net.IP, int, error) {
	tc, ok := conn.(*net.TCPConn)
	if !ok {
		return nil, 0, fmt.Errorf("not a TCP connection: %T", conn)
	}

	rc, err := tc.SyscallConn()
	if err != nil {
		return nil, 0, fmt.Errorf("syscall conn: %w", err)
	}

	var ip net.IP
	var port int
	var ctrlErr error

	err = rc.Control(func(fd uintptr) {
		// Try IPv4 first (sockaddr_in = 16 bytes)
		var addr [16]byte
		addrLen := uint32(len(addr))
		_, _, errno := syscall.Syscall6(
			syscall.SYS_GETSOCKOPT,
			fd,
			syscall.SOL_IP,
			soOriginalDst,
			uintptr(unsafe.Pointer(&addr)),
			uintptr(unsafe.Pointer(&addrLen)),
			0,
		)
		if errno == 0 {
			// sockaddr_in: family(2) + port(2 big-endian) + addr(4)
			port = int(binary.BigEndian.Uint16(addr[2:4]))
			ip = net.IPv4(addr[4], addr[5], addr[6], addr[7])
			return
		}

		// Try IPv6 (sockaddr_in6 = 28 bytes)
		var addr6 [28]byte
		addrLen6 := uint32(len(addr6))
		_, _, errno = syscall.Syscall6(
			syscall.SYS_GETSOCKOPT,
			fd,
			syscall.SOL_IPV6,
			soOriginalDstIPv6,
			uintptr(unsafe.Pointer(&addr6)),
			uintptr(unsafe.Pointer(&addrLen6)),
			0,
		)
		if errno == 0 {
			port = int(binary.BigEndian.Uint16(addr6[2:4]))
			ip = make(net.IP, 16)
			copy(ip, addr6[8:24])
			return
		}

		ctrlErr = fmt.Errorf("getsockopt SO_ORIGINAL_DST: %v", errno)
	})
	if err != nil {
		return nil, 0, fmt.Errorf("control: %w", err)
	}
	if ctrlErr != nil {
		return nil, 0, ctrlErr
	}
	return ip, port, nil
}
