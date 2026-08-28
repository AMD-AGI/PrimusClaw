// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package egress

import (
	"bytes"
	"io"
	"strings"
	"testing"
)

// buildClientHello constructs a minimal TLS 1.2 ClientHello with SNI extension.
func buildClientHello(sni string) []byte {
	// SNI extension payload: type(1) + nameLen(2) + name
	sniName := []byte(sni)
	sniEntry := make([]byte, 0, 3+len(sniName))
	sniEntry = append(sniEntry, 0x00)                                           // host_name type
	sniEntry = append(sniEntry, byte(len(sniName)>>8), byte(len(sniName)&0xff)) // name length
	sniEntry = append(sniEntry, sniName...)

	// SNI list: listLen(2) + entries
	sniList := make([]byte, 0, 2+len(sniEntry))
	sniList = append(sniList, byte(len(sniEntry)>>8), byte(len(sniEntry)&0xff))
	sniList = append(sniList, sniEntry...)

	// Extension: type(2) + len(2) + data
	ext := make([]byte, 0, 4+len(sniList))
	ext = append(ext, 0x00, 0x00) // SNI extension type
	ext = append(ext, byte(len(sniList)>>8), byte(len(sniList)&0xff))
	ext = append(ext, sniList...)

	// Extensions block: totalLen(2) + extensions
	exts := make([]byte, 0, 2+len(ext))
	exts = append(exts, byte(len(ext)>>8), byte(len(ext)&0xff))
	exts = append(exts, ext...)

	// ClientHello body: version(2) + random(32) + sessionID(1) + cipherSuites(4) + compression(2) + extensions
	chBody := make([]byte, 0, 2+32+1+4+2+len(exts))
	chBody = append(chBody, 0x03, 0x03)             // TLS 1.2
	chBody = append(chBody, make([]byte, 32)...)    // random
	chBody = append(chBody, 0x00)                   // session ID length = 0
	chBody = append(chBody, 0x00, 0x02, 0x00, 0x2f) // 1 cipher suite (TLS_RSA_WITH_AES_128_CBC_SHA)
	chBody = append(chBody, 0x01, 0x00)             // 1 compression method (null)
	chBody = append(chBody, exts...)

	// Handshake header: type(1) + length(3)
	hs := make([]byte, 0, 4+len(chBody))
	hs = append(hs, 0x01) // ClientHello
	hs = append(hs, byte(len(chBody)>>16), byte(len(chBody)>>8), byte(len(chBody)&0xff))
	hs = append(hs, chBody...)

	// TLS record header: ContentType(1) + Version(2) + Length(2)
	record := make([]byte, 0, 5+len(hs))
	record = append(record, 0x16)       // Handshake
	record = append(record, 0x03, 0x01) // TLS 1.0 (record layer version)
	record = append(record, byte(len(hs)>>8), byte(len(hs)&0xff))
	record = append(record, hs...)

	return record
}

func TestPeekClientDomain_TLS_SNI(t *testing.T) {
	hello := buildClientHello("api.example.com")
	trailer := []byte("remaining-data-after-hello")
	conn := io.MultiReader(bytes.NewReader(hello), bytes.NewReader(trailer))

	res := PeekClientDomain(conn)
	if !res.IsTLS {
		t.Error("expected IsTLS=true")
	}
	if res.Domain != "api.example.com" {
		t.Errorf("Domain=%q, want api.example.com", res.Domain)
	}

	// Verify the Reader contains all original data (peeked + rest)
	all, _ := io.ReadAll(res.Reader)
	expected := append(hello, trailer...)
	if !bytes.Equal(all, expected) {
		t.Errorf("Reader content mismatch: got %d bytes, want %d bytes", len(all), len(expected))
	}
}

func TestPeekClientDomain_HTTP_Host(t *testing.T) {
	httpReq := "GET / HTTP/1.1\r\nHost: www.example.com\r\nConnection: close\r\n\r\n"
	conn := strings.NewReader(httpReq)

	res := PeekClientDomain(conn)
	if res.IsTLS {
		t.Error("expected IsTLS=false for HTTP request")
	}
	if res.Domain != "www.example.com" {
		t.Errorf("Domain=%q, want www.example.com", res.Domain)
	}
}

func TestPeekClientDomain_HTTP_HostWithPort(t *testing.T) {
	httpReq := "GET / HTTP/1.1\r\nHost: www.example.com:8080\r\nConnection: close\r\n\r\n"
	conn := strings.NewReader(httpReq)

	res := PeekClientDomain(conn)
	if res.Domain != "www.example.com" {
		t.Errorf("Domain=%q, want www.example.com (port stripped)", res.Domain)
	}
}

func TestPeekClientDomain_HTTP_IPv6Host(t *testing.T) {
	httpReq := "GET / HTTP/1.1\r\nHost: [::1]:8080\r\nConnection: close\r\n\r\n"
	conn := strings.NewReader(httpReq)

	res := PeekClientDomain(conn)
	if res.Domain != "::1" {
		t.Errorf("Domain=%q, want '::1' (IPv6 brackets stripped, port removed)", res.Domain)
	}
}

func TestPeekClientDomain_HTTP_IPv6HostNoPort(t *testing.T) {
	httpReq := "GET / HTTP/1.1\r\nHost: [::1]\r\nConnection: close\r\n\r\n"
	conn := strings.NewReader(httpReq)

	res := PeekClientDomain(conn)
	// net.SplitHostPort fails on "[::1]" without port, falls back to raw Host
	if res.Domain != "[::1]" {
		t.Errorf("Domain=%q, want '[::1]'", res.Domain)
	}
}

func TestPeekClientDomain_Empty(t *testing.T) {
	conn := strings.NewReader("")
	res := PeekClientDomain(conn)
	if res.Domain != "" {
		t.Errorf("expected empty domain for empty stream, got %q", res.Domain)
	}
}

func TestPeekClientDomain_BinaryGarbage(t *testing.T) {
	conn := bytes.NewReader([]byte{0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa})
	res := PeekClientDomain(conn)
	if res.Domain != "" {
		t.Errorf("expected empty domain for garbage, got %q", res.Domain)
	}
	if res.IsTLS {
		t.Error("expected IsTLS=false for garbage")
	}
}

func TestPeekClientDomain_MultiReader_NoConsume(t *testing.T) {
	original := "GET /path HTTP/1.1\r\nHost: test.com\r\n\r\nbody-content-here"
	conn := strings.NewReader(original)

	res := PeekClientDomain(conn)
	all, _ := io.ReadAll(res.Reader)
	if string(all) != original {
		t.Errorf("MultiReader should replay entire stream.\ngot:  %q\nwant: %q", string(all), original)
	}
}
