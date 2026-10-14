// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package envd

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func newSessionTestServer(t *testing.T) *Server {
	t.Helper()
	return &Server{workspace: t.TempDir(), inference: &inferenceKeyCache{}, tmuxWidth: 80, tmuxHeight: 24}
}

// useTmux points the session handlers at bin for the duration of the test.
func useTmux(t *testing.T, bin string) {
	t.Helper()
	prev := sessionTmux
	sessionTmux = newTmuxCLI(func() string { return bin })
	t.Cleanup(func() { sessionTmux = prev })
}

func serve(t *testing.T, s *Server, method, target, body string, h func(http.ResponseWriter, *http.Request)) {
	t.Helper()
	rec := httptest.NewRecorder()
	h(rec, httptest.NewRequest(method, target, strings.NewReader(body)))
	if rec.Code >= 300 {
		t.Fatalf("%s %s: %d %s", method, target, rec.Code, rec.Body.String())
	}
}

// canSetGroups reports whether this process may set its supplementary groups
// (CAP_SETGID), by setting them to what they already are.
func canSetGroups() bool {
	groups, err := syscall.Getgroups()
	return err == nil && syscall.Setgroups(groups) == nil
}

// Every tmux command a session or terminal endpoint runs names envd's own
// socket, so none of them can reach a tmux server the workload started.
func TestSessionEndpointsUseEnvdTmuxSocket(t *testing.T) {
	dir := t.TempDir()
	log := filepath.Join(dir, "argv")
	fake := filepath.Join(dir, "tmux")
	if err := os.WriteFile(fake, []byte("#!/bin/sh\nprintf '%s\\n' \"$*\" >> '"+log+"'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	useTmux(t, fake)
	s := newSessionTestServer(t)
	id := "abc"
	want := []string{"send-keys", "capture-pane", "kill-session"}
	// Creating a session starts tmux with the pod's groups minus the proxy
	// group, which only a process allowed to set its groups can do.
	if canSetGroups() {
		serve(t, s, http.MethodPost, "/api/session/create", "", s.handleSessionCreate)
		want = append(want, "new-session")
	} else {
		t.Log("this process cannot set its groups, so session create is not recorded")
	}
	serve(t, s, http.MethodPost, "/", `{"command":"true","timeout":"150ms"}`, func(w http.ResponseWriter, r *http.Request) { s.handleSessionExec(w, r, id) })
	serve(t, s, http.MethodGet, "/", "", func(w http.ResponseWriter, r *http.Request) { s.handleSessionOutput(w, r, id) })
	serve(t, s, http.MethodPost, "/", `{"keys":["ls","Enter","C-c"]}`, func(w http.ResponseWriter, r *http.Request) { s.handleTerminalSendKeys(w, r, id) })
	serve(t, s, http.MethodGet, "/", "", func(w http.ResponseWriter, r *http.Request) { s.handleTerminalScreen(w, r, id) })
	serve(t, s, http.MethodDelete, "/", "", func(w http.ResponseWriter, r *http.Request) { s.handleSessionDelete(w, r, id) })

	b, err := os.ReadFile(log)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	seen := map[string]bool{}
	for _, l := range lines {
		f := strings.Fields(l)
		if len(f) < 3 || f[0] != "-L" || f[1] != tmuxSocketName {
			t.Fatalf("tmux ran as %q, not on envd's socket", l)
		}
		seen[f[2]] = true
	}
	for _, sub := range want {
		if !seen[sub] {
			t.Fatalf("no %s among the recorded tmux commands:\n%s", sub, b)
		}
	}
}

// With a real tmux: a server the workload starts on the default socket and
// envd's sessions do not see each other.
func TestSessionsLiveApartFromTheWorkloadsTmux(t *testing.T) {
	bin, err := exec.LookPath("tmux")
	if err != nil {
		t.Skip("no tmux on this host")
	}
	// Keep both servers' sockets under the test's own directory.
	t.Setenv("TMUX_TMPDIR", t.TempDir())
	t.Setenv("TMUX", "")
	useTmux(t, bin)
	user := func(args ...string) (string, error) {
		out, err := exec.Command(bin, args...).CombinedOutput()
		return string(out), err
	}
	if out, err := user("new-session", "-d", "-s", "workload"); err != nil {
		t.Fatalf("starting the workload's tmux: %v %s", err, out)
	}
	t.Cleanup(func() { _, _ = user("kill-server") })
	t.Cleanup(func() { _ = sessionTmux.command(context.Background(), "kill-server").Run() })

	// The session is started the way handleSessionCreate starts it, minus the
	// group change that needs privileges; the endpoints then reach it.
	if out, err := sessionTmux.command(context.Background(), "new-session", "-d", "-s", "sandbox-iso", "-x", "80", "-y", "24").CombinedOutput(); err != nil {
		t.Fatalf("starting envd's session: %v %s", err, out)
	}
	s := newSessionTestServer(t)
	rec := httptest.NewRecorder()
	s.handleSessionExec(rec, httptest.NewRequest(http.MethodPost, "/", strings.NewReader(`{"command":"echo envd-$((40+2))","timeout":"10s"}`)), "iso")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "envd-42") {
		t.Fatalf("exec on envd's session: %d %s", rec.Code, rec.Body.String())
	}

	workload, err := user("list-sessions", "-F", "#{session_name}")
	if err != nil {
		t.Fatalf("listing the workload's server: %v %s", err, workload)
	}
	if strings.TrimSpace(workload) != "workload" {
		t.Fatalf("the workload's tmux server lists %q; envd's session landed on it", workload)
	}
	envd, err := sessionTmux.command(context.Background(), "list-sessions", "-F", "#{session_name}").CombinedOutput()
	if err != nil {
		t.Fatalf("listing envd's server: %v %s", err, envd)
	}
	if got := strings.TrimSpace(string(envd)); got != "sandbox-iso" {
		t.Fatalf("envd's tmux server lists %q, want only sandbox-iso", got)
	}
}

// The binary is resolved once: a tmux appearing (or vanishing) later must not
// split one server's clients across two builds.
func TestSessionTmuxResolvesItsBinaryOnce(t *testing.T) {
	calls := 0
	paths := []string{"/first/tmux", "/second/tmux"}
	cli := newTmuxCLI(func() string {
		p := paths[min(calls, len(paths)-1)]
		calls++
		return p
	})
	for i := 0; i < 3; i++ {
		if got := cli.command(context.Background(), "ls").Path; got != "/first/tmux" {
			t.Fatalf("call %d ran %q, want the first resolution", i, got)
		}
	}
	if calls != 1 {
		t.Fatalf("resolved %d times, want once", calls)
	}
}

// Without an injected copy the bare name is looked up on PATH once: a tmux the
// workload puts earlier on PATH later does not become the client of the
// server the first one started.
func TestSessionTmuxPinsThePATHLookup(t *testing.T) {
	first, later := t.TempDir(), t.TempDir()
	for _, d := range []string{first, later} {
		if err := os.WriteFile(filepath.Join(d, "tmux"), []byte("#!/bin/sh\n"), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", first)
	cli := newTmuxCLI(func() string { return "tmux" })
	want := filepath.Join(first, "tmux")
	if got := cli.command(context.Background(), "ls").Path; got != want {
		t.Fatalf("first command ran %q, want %q", got, want)
	}
	t.Setenv("PATH", later+":"+first)
	if got := cli.command(context.Background(), "ls").Path; got != want {
		t.Fatalf("after PATH changed, ran %q, want the first resolution %q", got, want)
	}
}
