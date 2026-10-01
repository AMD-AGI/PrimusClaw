// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package cmdlog

import "regexp"

// Mask replaces every credential Redact finds.
const Mask = "***"

// sensitiveName is the tail of a variable or parameter name whose value is a
// credential: AUTH_CLAW_TOKEN, access_token, AWS_SECRET_ACCESS_KEY,
// OPENAI_API_KEY, PGPASSWORD, X-Amz-Signature.
const sensitiveName = `(?:token|secret|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key|x-amz-signature|x-amz-credential)`

// credentialPatterns are the shapes a credential takes in a command line, a
// URL or a header dump. Each keeps the name and drops the value, so a record
// still says what was sent without saying what it was.
//
// A value that starts with `$` is a shell reference, not a credential, and is
// left readable: `-H "Authorization: Bearer ${AUTH_CLAW_TOKEN}"` is exactly the
// form a caller should use, and masking it would hide whether it did.
var credentialPatterns = []struct {
	re   *regexp.Regexp
	repl string
}{
	// Authorization: <scheme> <value>, and "Authorization": "<scheme> <value>".
	{regexp.MustCompile(`(?i)(authorization["']?\s*[:=]\s*["']?(?:bearer|basic|token|digest)\s+)[^\s$'",;&][^\s'",;&]*`), "${1}" + Mask},
	// Authorization: <value> with no scheme, as a header dump prints it. A
	// scheme word alone is left for the pattern above (or is followed by a shell
	// reference, which stays readable); RE2 has no lookahead, so the check is in
	// redactSchemeless.
	// Bearer <value> anywhere else (a header built in pieces, an error message).
	{regexp.MustCompile(`(?i)\b(bearer\s+)[A-Za-z0-9._~+/=-]+`), "${1}" + Mask},
	// token=, access_token=, AUTH_CLAW_TOKEN=, X-Amz-Security-Token=, and the
	// same for secrets, passwords, API and access keys and signed-URL
	// signatures; bare or quoted (NAME='v', NAME="v").
	{regexp.MustCompile(`(?i)\b([A-Za-z0-9_.-]*` + sensitiveName + `=["']?)[^\s$&'"][^\s&'"]*`), "${1}" + Mask},
	// X-API-Key: <value>, X-Auth-Token: <value> and the like, as headers.
	{regexp.MustCompile(`(?i)\b((?:x-)?(?:api[_-]?key|auth[_-]?token|access[_-]?token)["']?\s*:\s*["']?)[^\s$'",;&][^\s'",;&]*`), "${1}" + Mask},
	// "token": "<value>" and the like, as JSON puts them.
	{regexp.MustCompile(`(?i)("[A-Za-z0-9_.-]*` + sensitiveName + `"\s*:\s*")[^"]*`), "${1}" + Mask},
}

// Redact masks credentials in a string bound for a log record.
//
// The Router and EnvD log the command line of every execute, and a command
// line is where a careless caller puts a header or an env assignment. Masking
// here is the second line; the first is callers passing secrets in the execute
// request's env map instead.
func Redact(v string) string {
	for _, p := range credentialPatterns {
		v = p.re.ReplaceAllString(v, p.repl)
	}
	return schemelessAuthorization.ReplaceAllStringFunc(v, redactSchemeless)
}

var (
	schemelessAuthorization = regexp.MustCompile(`(?i)(authorization["']?\s*[:=]\s*["']?)([^\s$'",;&][^\s'",;&]*)`)
	authScheme              = regexp.MustCompile(`(?i)^(?:bearer|basic|token|digest)$`)
)

func redactSchemeless(m string) string {
	sub := schemelessAuthorization.FindStringSubmatch(m)
	if sub[2] == Mask || authScheme.MatchString(sub[2]) {
		return m
	}
	return sub[1] + Mask
}
