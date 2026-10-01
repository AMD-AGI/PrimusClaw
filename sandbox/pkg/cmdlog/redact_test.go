// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package cmdlog

import (
	"strings"
	"testing"
)

const secret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func TestRedactMasksCredentialShapes(t *testing.T) {
	cases := map[string]string{
		"curl header":        `curl -sfL -H 'Authorization: Bearer ` + secret + `' https://brain/x`,
		"header dump":        "Authorization: " + secret,
		"basic":              "Authorization: Basic " + secret,
		"bare bearer":        "sent Bearer " + secret + " upstream",
		"env assignment":     "AUTH_CLAW_TOKEN=" + secret + " CLAW_SESSION_ID=s1 setsid /app/hands",
		"query token":        "GET /x?token=" + secret + "&a=1",
		"access_token":       "access_token=" + secret,
		"amz signature":      "https://s3/x?X-Amz-Credential=" + secret + "&X-Amz-Signature=" + secret,
		"amz session token":  "X-Amz-Security-Token=" + secret,
		"api key":            "OPENAI_API_KEY=" + secret,
		"password":           "PGPASSWORD=" + secret + " psql",
		"json":               `{"token":"` + secret + `","n":1}`,
		"json authz":         `{"Authorization": "Bearer ` + secret + `"}`,
		"single-quoted":      "AUTH_CLAW_TOKEN='" + secret + "' /app/hands",
		"double-quoted":      `OPENAI_API_KEY="` + secret + `" python x.py`,
		"aws secret":         "AWS_SECRET_ACCESS_KEY=" + secret,
		"quoted with space":  "PGPASSWORD='" + secret + " " + secret + "' psql",
		"dq with space":      `PGPASSWORD="` + secret + ` ` + secret + `" psql`,
		"sq literal dollar":  "PGPASSWORD='$" + secret + "' psql",
		"escaped space":      `PGPASSWORD=` + secret + `\ ` + secret + ` psql`,
		"dq escaped quote":   `PGPASSWORD="` + secret + `\"` + secret + `" psql`,
		"api key header":     "curl -H 'X-API-KEY: " + secret + "' https://x",
		"auth token header":  "X-Auth-Token: " + secret,
		"hands token header": "GET /x HTTP/1.1\r\nHost: h\r\nX-Hands-Token: " + secret + "\r\nAccept: */*\r\n",
	}
	for name, in := range cases {
		got := Redact(in)
		if strings.Contains(got, secret) {
			t.Errorf("%s: credential survived: %q", name, got)
		}
		if !strings.Contains(got, Mask) {
			t.Errorf("%s: nothing was masked: %q", name, got)
		}
	}
}

// A shell reference is what a careful caller puts in the command line, so it
// must stay readable: masking it would hide whether the caller did it right.
func TestRedactLeavesShellReferencesAndOrdinaryText(t *testing.T) {
	keep := []string{
		`curl -H "Authorization: Bearer ${AUTH_CLAW_TOKEN}" https://brain/x`,
		`printf '%s' "$CLAW_HANDS_ENV_B64" | base64 -d > /tmp/.hands-env`,
		`echo max_tokens=100 tokens=5`,
		`export AUTH_CLAW_TOKEN="$AUTH_CLAW_TOKEN"`,
		`curl -H "X-API-Key: ${KEY}" https://x`,
		`loaded Router public key from secret agent-sandbox-system/router-key`,
		`sh -c ls -la /tmp`,
		"GET /x HTTP/1.1\r\nAccept: text/event-stream\r\nMcp-Session-Id: abc\r\nSec-Fetch-Mode: cors\r\n",
	}
	for _, in := range keep {
		if got := Redact(in); got != in {
			t.Errorf("Redact changed text with no credential in it:\n in: %q\nout: %q", in, got)
		}
	}
}

// The cut must come after the mask: a credential split by the length cap is no
// longer recognisable, and its first half would reach the log.
func TestPreviewAndValueMaskBeforeTruncating(t *testing.T) {
	long := strings.Repeat("x", 230) + " -H 'Authorization: Bearer " + secret + "'"
	if got := Value(long); strings.Contains(got, secret[:16]) {
		t.Errorf("Value let part of a credential through: %q", got)
	}
	if got := Preview([]string{"sh", "-c", long}, 260); strings.Contains(got, secret[:16]) {
		t.Errorf("Preview let part of a credential through: %q", got)
	}
}

// An argv element is one value however many spaces it holds; masking only the
// joined line would cut it at the first one.
func TestPreviewMasksAWholeAssignmentArgument(t *testing.T) {
	got := Preview([]string{"env", "PGPASSWORD=" + secret + " " + secret, "psql"}, 0)
	if strings.Contains(got, secret) {
		t.Errorf("Preview let part of an argv assignment through: %q", got)
	}
	if got := Preview([]string{"env", "AUTH_CLAW_TOKEN=$AUTH_CLAW_TOKEN", "x"}, 0); !strings.Contains(got, "$AUTH_CLAW_TOKEN") {
		t.Errorf("Preview masked a shell reference: %q", got)
	}
}

func TestRedactingWriterMasksAndReportsTheCallerLength(t *testing.T) {
	var b strings.Builder
	in := "X-Hands-Token: " + secret + "\n"
	n, err := RedactingWriter(&b).Write([]byte(in))
	if err != nil || n != len(in) {
		t.Fatalf("Write = %d, %v; want %d, nil", n, err, len(in))
	}
	if strings.Contains(b.String(), secret) {
		t.Errorf("credential survived: %q", b.String())
	}
}
