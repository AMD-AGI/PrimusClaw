// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package egress

import (
	"bufio"
	"io"
	"net"
	"net/http"
	"strings"
)

// PeekResult holds the extracted domain and a reconstituted reader that
// includes the already-peeked bytes (via io.MultiReader), so the original
// stream is not consumed.
type PeekResult struct {
	Domain string    // SNI server_name or HTTP Host header; empty if extraction failed
	IsTLS  bool      // true when a TLS ClientHello was detected
	Reader io.Reader // MultiReader(peeked + remaining), ready for forwarding
}

const maxPeekBytes = 1024

// PeekClientDomain reads the first bytes of a connection to extract the
// target domain. For TLS connections it parses the ClientHello SNI extension;
// for plaintext HTTP it reads the Host header.
// The returned PeekResult.Reader replays peeked bytes + rest of stream.
func PeekClientDomain(conn io.Reader) PeekResult {
	buf := make([]byte, maxPeekBytes)
	n, _ := io.ReadAtLeast(conn, buf, 1)
	if n == 0 {
		return PeekResult{Reader: conn}
	}
	peeked := buf[:n]
	combined := io.MultiReader(strings.NewReader(string(peeked)), conn)

	if n >= 5 && peeked[0] == 0x16 && peeked[1] == 0x03 {
		sni := parseSNI(peeked)
		return PeekResult{Domain: sni, IsTLS: true, Reader: combined}
	}

	host := parseHTTPHost(peeked)
	return PeekResult{Domain: host, IsTLS: false, Reader: combined}
}

// parseSNI extracts the server_name from a TLS ClientHello.
// Minimal parser: only handles the SNI extension (type 0x0000).
func parseSNI(data []byte) string {
	if len(data) < 5 {
		return ""
	}
	// TLS record header: ContentType(1) + Version(2) + Length(2)
	recordLen := int(data[3])<<8 | int(data[4])
	if recordLen+5 > len(data) {
		recordLen = len(data) - 5
	}
	payload := data[5 : 5+recordLen]

	if len(payload) < 4 {
		return ""
	}
	// Handshake header: Type(1) + Length(3)
	if payload[0] != 0x01 { // ClientHello
		return ""
	}
	hsLen := int(payload[1])<<16 | int(payload[2])<<8 | int(payload[3])
	if hsLen+4 > len(payload) {
		hsLen = len(payload) - 4
	}
	hs := payload[4 : 4+hsLen]

	// ClientHello: Version(2) + Random(32) = 34 bytes
	if len(hs) < 34 {
		return ""
	}
	pos := 34

	// Session ID
	if pos >= len(hs) {
		return ""
	}
	sidLen := int(hs[pos])
	pos += 1 + sidLen
	if pos+2 > len(hs) {
		return ""
	}

	// Cipher Suites
	csLen := int(hs[pos])<<8 | int(hs[pos+1])
	pos += 2 + csLen
	if pos >= len(hs) {
		return ""
	}

	// Compression Methods
	cmLen := int(hs[pos])
	pos += 1 + cmLen
	if pos+2 > len(hs) {
		return ""
	}

	// Extensions length
	extLen := int(hs[pos])<<8 | int(hs[pos+1])
	pos += 2
	extEnd := pos + extLen
	if extEnd > len(hs) {
		extEnd = len(hs)
	}

	for pos+4 <= extEnd {
		extType := int(hs[pos])<<8 | int(hs[pos+1])
		eLen := int(hs[pos+2])<<8 | int(hs[pos+3])
		pos += 4
		if pos+eLen > extEnd {
			break
		}
		if extType == 0x0000 { // SNI
			return extractSNIName(hs[pos : pos+eLen])
		}
		pos += eLen
	}
	return ""
}

func extractSNIName(data []byte) string {
	if len(data) < 2 {
		return ""
	}
	// SNI list length
	listLen := int(data[0])<<8 | int(data[1])
	_ = listLen
	p := 2
	for p+3 <= len(data) {
		nameType := data[p]
		nameLen := int(data[p+1])<<8 | int(data[p+2])
		p += 3
		if p+nameLen > len(data) {
			break
		}
		if nameType == 0x00 { // host_name
			return string(data[p : p+nameLen])
		}
		p += nameLen
	}
	return ""
}

// parseHTTPHost extracts the Host header from a plaintext HTTP request.
// Uses net.SplitHostPort for correct IPv6 bracket handling (e.g. [::1]:8080).
func parseHTTPHost(data []byte) string {
	r := bufio.NewReader(strings.NewReader(string(data)))
	req, err := http.ReadRequest(r)
	if err != nil {
		return ""
	}
	h, _, err := net.SplitHostPort(req.Host)
	if err != nil {
		return req.Host
	}
	return h
}
