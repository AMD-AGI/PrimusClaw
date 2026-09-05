// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package logx

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// The guarantee this package makes is worth exactly its coverage: one slog.Info
// left somewhere in the tree logs its values raw, and nothing about the record
// says so.
//
// The guard is on the import, not on the call. Two earlier versions were on the
// call and both failed, from opposite directions.
//
// The first asked "is every request-derived value wrapped?" -- a judgement, so
// it became a list of key names that looked request-derived, and the list had
// holes: "timeout" was not in it, and CodeQL found three sites behind that key.
//
// The second matched call expressions -- `slog.Info(`, `log.FromContext(`. That
// broke the moment logx was imported under an alias, because `log.FromContext(`
// became the correct call; a regex cannot tell which package a name refers to
// without resolving imports. Reading the imports is the same question asked
// where the answer is: nothing can call a logger it has not imported, whatever
// it names the import.
var loggingImports = regexp.MustCompile(
	`^\s*(?:[\w.]+\s+)?"(log|log/slog|k8s\.io/klog/v2|github\.com/go-logr/logr|` +
		`sigs\.k8s\.io/controller-runtime/pkg/log)"\s*$`)

// Files that may import a logger directly, with the reason.
var mayImportALogger = map[string]string{
	"pkg/logx/logx.go":    "the seam: it is what calls slog and logr",
	"pkg/logx/install.go": "points slog, klog and controller-runtime at one handler",
	// Holds a logr.Logger to hand to a library that demands one. It logs
	// nothing caller-controlled through it; see logx.Logger.Logr.
	"internal/metrics/tracing.go": "stores a logr.Logger for an OTel component",
}

func TestNothingOutsideThisPackageImportsALoggerDirectly(t *testing.T) {
	var offenders []string
	err := filepath.Walk("../..", func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() || !strings.HasSuffix(path, ".go") {
			return nil
		}
		if strings.HasSuffix(path, "_test.go") {
			return nil
		}
		rel := strings.TrimPrefix(filepath.ToSlash(path), "../../")
		if _, ok := mayImportALogger[rel]; ok {
			return nil
		}
		src, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		for i, line := range strings.Split(string(src), "\n") {
			if strings.Contains(line, "// logx-exempt:") {
				continue
			}
			if loggingImports.MatchString(line) {
				offenders = append(offenders, rel+":"+itoa(i+1)+"  "+strings.TrimSpace(line))
			}
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk: %v", err)
	}
	if len(offenders) > 0 {
		t.Errorf("%d file(s) import a logger directly, so their values can reach "+
			"a record unescaped; import log \"sigs.k8s.io/agent-sandbox/pkg/logx\" "+
			"instead:\n  %s", len(offenders), strings.Join(offenders, "\n  "))
	}
}

// The positive control. A tree-wide scan that finds nothing is
// indistinguishable from a matcher that no longer matches anything, and this
// one guards every log statement in the repository.
func TestTheScannerCatchesTheImportsItIsMeantTo(t *testing.T) {
	mustFlag := map[string]string{
		"stdlib log":         `	"log"`,
		"slog":               `	"log/slog"`,
		"klog":               `	"k8s.io/klog/v2"`,
		"logr":               `	"github.com/go-logr/logr"`,
		"controller-runtime": `	"sigs.k8s.io/controller-runtime/pkg/log"`,
		"aliased slog":       `	stdlog "log/slog"`,
		"aliased klog":       `	zzz "k8s.io/klog/v2"`,
	}
	for name, src := range mustFlag {
		if !loggingImports.MatchString(src) {
			t.Errorf("scanner misses %s; a tree full of them would read as clean:\n%s", name, src)
		}
	}

	mustNotFlag := map[string]string{
		"the seam, aliased": `	log "sigs.k8s.io/agent-sandbox/pkg/logx"`,
		"the seam, plain":   `	"sigs.k8s.io/agent-sandbox/pkg/logx"`,
		"zap, a handler rather than a logging API this tree calls": `	"sigs.k8s.io/controller-runtime/pkg/log/zap"`,
		"an unrelated package whose name ends in log":              `	"github.com/example/catalog"`,
		"a call rather than an import":                             `	log.Info("x", "sessionId", sessionID)`,
	}
	for name, src := range mustNotFlag {
		if loggingImports.MatchString(src) {
			t.Errorf("scanner flags %s, which is not a direct logger import:\n%s", name, src)
		}
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
