// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package e2b

import (
	"bytes"
	"context"
	"encoding/binary"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"google.golang.org/protobuf/encoding/protowire"

	e2bapi "sigs.k8s.io/agent-sandbox/pkg/e2b"
)

func TestConnectStartFilesAndSignal(t *testing.T) {
	ws := t.TempDir()
	out := ws + "/out"
	mux := http.NewServeMux()
	Mount(mux, ws, execStarter(ws))
	srv := httptest.NewServer(mux)
	defer srv.Close()

	stdout, code := runProto(t, srv.URL, protoStart("sh", "-c", "printf hello"))
	if code != 0 || stdout != "hello" {
		t.Fatalf("stdout=%q code=%d", stdout, code)
	}

	wrote := postRaw(t, srv.URL+"/files?path="+out+"/a.txt", "text/plain", []byte("hi"))
	wroteBody, _ := io.ReadAll(wrote.Body)
	_ = wrote.Body.Close()
	if wrote.StatusCode != http.StatusOK || !strings.Contains(string(wroteBody), `"name":"a.txt"`) || !strings.HasPrefix(strings.TrimSpace(string(wroteBody)), "[") {
		t.Fatalf("upload %d %s", wrote.StatusCode, wroteBody)
	}
	got := getRaw(t, srv.URL+"/files?path="+out+"/a.txt")
	if got != "hi" {
		t.Fatalf("download %q", got)
	}

	stat := postRaw(t, srv.URL+"/filesystem.Filesystem/Stat", "application/proto", appendString(nil, 1, out+"/a.txt"))
	if stat.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(stat.Body)
		t.Fatalf("stat %d %s", stat.StatusCode, body)
	}
	statBody, _ := io.ReadAll(stat.Body)
	_ = stat.Body.Close()
	if !bytes.Contains(statBody, []byte(out+"/a.txt")) {
		t.Fatalf("stat body %x", statBody)
	}

	mk := postRaw(t, srv.URL+"/filesystem.Filesystem/MakeDir", "application/proto", appendString(nil, 1, out+"/dir"))
	if mk.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(mk.Body)
		t.Fatalf("mkdir %d %s", mk.StatusCode, body)
	}
	_ = mk.Body.Close()
	listed := postRaw(t, srv.URL+"/filesystem.Filesystem/ListDir", "application/proto", appendString(nil, 1, out))
	listBody, _ := io.ReadAll(listed.Body)
	_ = listed.Body.Close()
	if listed.StatusCode != http.StatusOK || !bytes.Contains(listBody, []byte("a.txt")) || !bytes.Contains(listBody, []byte("dir")) {
		t.Fatalf("list %d %q", listed.StatusCode, listBody)
	}
	moved := postRaw(t, srv.URL+"/filesystem.Filesystem/Move", "application/proto", protoMove(out+"/a.txt", out+"/b.txt"))
	if moved.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(moved.Body)
		t.Fatalf("move %d %s", moved.StatusCode, body)
	}
	_ = moved.Body.Close()
	removed := postRaw(t, srv.URL+"/filesystem.Filesystem/Remove", "application/proto", appendString(nil, 1, out+"/b.txt"))
	if removed.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(removed.Body)
		t.Fatalf("remove %d %s", removed.StatusCode, body)
	}
	_ = removed.Body.Close()

	headerOnly := postHeader(t, srv.URL+"/process.Process/Start", "application/proto", protoStart("sh", "-c", "printf no"), map[string]string{
		"X-Sandbox-Sealed":  "true",
		"X-Sandbox-Inputs":  "/in",
		"X-Sandbox-Outputs": "/out",
	})
	if headerOnly.StatusCode == http.StatusForbidden {
		t.Fatal("sealed headers must not restrict the sandbox")
	}
	_ = headerOnly.Body.Close()

	sealedMux := http.NewServeMux()
	Mount(sealedMux, ws, execStarter(ws))
	sealedSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sealedMux.ServeHTTP(w, r.WithContext(e2bapi.WithRequestPolicy(r.Context(), e2bapi.RequestPolicy{
			Sealed: true, Inputs: []string{"/in"}, Outputs: []string{"/out"},
		})))
	}))
	defer sealedSrv.Close()

	sealed := postHeader(t, sealedSrv.URL+"/process.Process/Start", "application/proto", protoStart("sh", "-c", "printf no"), map[string]string{
		"X-Sandbox-Sealed": "false",
	})
	if sealed.StatusCode != http.StatusForbidden {
		t.Fatalf("sealed process %d", sealed.StatusCode)
	}
	_ = sealed.Body.Close()

	denied := postHeader(t, sealedSrv.URL+"/files?path=/out/a.txt", "text/plain", []byte("x"), map[string]string{
		"X-Sandbox-Sealed": "false",
	})
	if denied.StatusCode != http.StatusForbidden {
		t.Fatalf("sealed write %d", denied.StatusCode)
	}
	_ = denied.Body.Close()
}

func TestFilesystemErrorOmitsTheContainerPath(t *testing.T) {
	ws := t.TempDir()
	mux := http.NewServeMux()
	Mount(mux, ws, execStarter(ws))
	srv := httptest.NewServer(mux)
	defer srv.Close()
	resp := postRaw(t, srv.URL+"/filesystem.Filesystem/Stat", "application/proto", appendString(nil, 1, "in/sub"))
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusNotFound || strings.Contains(string(body), ws) || strings.Contains(string(body), "/app") {
		t.Fatalf("status=%d body=%s", resp.StatusCode, body)
	}
}

// An unsealed sandbox serves E2B's path semantics: an absolute path is that
// path, so a file written to /tmp/x is the /tmp/x a command reads. It used to
// land under the workspace, so files.write("/tmp/x") followed by
// commands.run("cat /tmp/x") found nothing.
func TestUnsealedAbsolutePathIsThatPath(t *testing.T) {
	ws := t.TempDir()
	other := t.TempDir()
	mux := http.NewServeMux()
	Mount(mux, ws, execStarter(ws))
	srv := httptest.NewServer(mux)
	defer srv.Close()

	target := other + "/x.txt"
	wrote := postRaw(t, srv.URL+"/files?path="+target, "text/plain", []byte("written-by-files"))
	body, _ := io.ReadAll(wrote.Body)
	_ = wrote.Body.Close()
	if wrote.StatusCode != http.StatusOK || !strings.Contains(string(body), `"path":"`+target+`"`) {
		t.Fatalf("upload %d %s", wrote.StatusCode, body)
	}
	if got, err := os.ReadFile(target); err != nil || string(got) != "written-by-files" {
		t.Fatalf("file at %s: %q %v", target, got, err)
	}
	if _, err := os.Stat(ws + target); !os.IsNotExist(err) {
		t.Fatalf("upload was mapped under the workspace: %v", err)
	}
	if stdout, code := runProto(t, srv.URL, protoStart("cat", target)); code != 0 || stdout != "written-by-files" {
		t.Fatalf("cat %s: stdout=%q code=%d", target, stdout, code)
	}
	if got := getRaw(t, srv.URL+"/files?path="+target); got != "written-by-files" {
		t.Fatalf("download %q", got)
	}

	// A relative path is taken from the workspace, and is reported as the
	// absolute path it names.
	stat := postRaw(t, srv.URL+"/files?path=rel/a.txt", "text/plain", []byte("rel"))
	statBody, _ := io.ReadAll(stat.Body)
	_ = stat.Body.Close()
	if stat.StatusCode != http.StatusOK || !strings.Contains(string(statBody), `"path":"`+ws+`/rel/a.txt"`) {
		t.Fatalf("relative upload %d %s", stat.StatusCode, statBody)
	}
	if got, err := os.ReadFile(ws + "/rel/a.txt"); err != nil || string(got) != "rel" {
		t.Fatalf("relative file: %q %v", got, err)
	}

	// A command started with an absolute cwd runs there.
	cfg := processConfig{Cmd: "pwd", Cwd: other}
	if stdout, code := runProto(t, srv.URL, appendMessage(nil, 1, encodeProcessConfig(cfg))); code != 0 || strings.TrimSpace(stdout) != other {
		t.Fatalf("pwd with cwd %s: stdout=%q code=%d", other, stdout, code)
	}
}

// A sealed sandbox keeps its grant's paths rooted at the workspace: the
// grant's "/in" is "<workspace>/in". A path that leaves the workspace gets an
// error that says so, and a path outside the allow-list is refused, never
// mapped elsewhere.
func TestSealedPathsStayUnderTheWorkspace(t *testing.T) {
	ws := t.TempDir()
	mux := http.NewServeMux()
	Mount(mux, ws, execStarter(ws))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mux.ServeHTTP(w, r.WithContext(e2bapi.WithRequestPolicy(r.Context(), e2bapi.RequestPolicy{
			Sealed: true, Inputs: []string{"/in"}, Outputs: []string{"/"},
		})))
	}))
	defer srv.Close()

	wrote := postRaw(t, srv.URL+"/files?path=/in/a.txt", "text/plain", []byte("sealed"))
	body, _ := io.ReadAll(wrote.Body)
	_ = wrote.Body.Close()
	if wrote.StatusCode != http.StatusOK || !strings.Contains(string(body), `"path":"/in/a.txt"`) {
		t.Fatalf("sealed upload %d %s", wrote.StatusCode, body)
	}
	if got, err := os.ReadFile(ws + "/in/a.txt"); err != nil || string(got) != "sealed" {
		t.Fatalf("sealed file under the workspace: %q %v", got, err)
	}
	if got := getRaw(t, srv.URL+"/files?path=/in/a.txt"); got != "sealed" {
		t.Fatalf("sealed download %q", got)
	}

	escaped := postRaw(t, srv.URL+"/filesystem.Filesystem/Stat", "application/json", []byte(`{"path":"../outside"}`))
	escBody, _ := io.ReadAll(escaped.Body)
	_ = escaped.Body.Close()
	if escaped.StatusCode != http.StatusForbidden || !strings.Contains(string(escBody), "escapes the sandbox root") {
		t.Fatalf("sealed escape %d %s", escaped.StatusCode, escBody)
	}

	outside := postRaw(t, srv.URL+"/files?path=/tmp/sealed-outside.txt", "text/plain", []byte("x"))
	outBody, _ := io.ReadAll(outside.Body)
	_ = outside.Body.Close()
	if outside.StatusCode != http.StatusForbidden || !strings.Contains(string(outBody), "sealed_denied") {
		t.Fatalf("sealed write outside the allow-list %d %s", outside.StatusCode, outBody)
	}
}

func TestEnvelopedStart(t *testing.T) {
	ws := t.TempDir()
	mux := http.NewServeMux()
	Mount(mux, ws, execStarter(ws))
	srv := httptest.NewServer(mux)
	defer srv.Close()

	msg := protoStart("sh", "-c", "printf hello")
	var hdr [5]byte
	binary.BigEndian.PutUint32(hdr[1:], uint32(len(msg)))
	body := append(append([]byte{}, hdr[:]...), msg...)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, srv.URL+"/process.Process/Start", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/connect+proto")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("start %d %s", resp.StatusCode, b)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/connect+proto" {
		t.Fatalf("content-type %s", ct)
	}
	events, err := readEvents(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	var out strings.Builder
	code := -1
	for _, ev := range events {
		if len(ev.data) > 0 && !ev.err {
			out.Write(ev.data)
		}
		if ev.end {
			code = ev.code
		}
	}
	if code != 0 || out.String() != "hello" {
		t.Fatalf("stdout=%q code=%d", out.String(), code)
	}
}

func TestStartOmitsStdinEnds(t *testing.T) {
	ws := t.TempDir()
	mux := http.NewServeMux()
	Mount(mux, ws, execStarter(ws))
	srv := httptest.NewServer(mux)
	defer srv.Close()

	body := protoStartStdin("sh", nil, "-c", "printf hello")
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, srv.URL+"/process.Process/Start", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/proto")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	events, err := readEvents(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	var out strings.Builder
	ended := false
	for _, ev := range events {
		if len(ev.data) > 0 && !ev.err {
			out.Write(ev.data)
		}
		if ev.end {
			ended = true
		}
	}
	if !ended || out.String() != "hello" {
		t.Fatalf("stdout=%q ended=%v", out.String(), ended)
	}
}

func TestStdinAndSignal(t *testing.T) {
	ws := t.TempDir()
	mux := http.NewServeMux()
	Mount(mux, ws, execStarter(ws))
	srv := httptest.NewServer(mux)
	defer srv.Close()

	on := true
	body := protoStartStdin("sh", &on, "-c", `read line; printf %s "$line"`)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, srv.URL+"/process.Process/Start", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/proto")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("start %d %s", resp.StatusCode, b)
	}
	first, err := readEvent(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if !first.start || first.pid == 0 {
		t.Fatalf("start event %#v", first)
	}
	sent := postRaw(t, srv.URL+"/process.Process/SendInput", "application/proto", protoInput(first.pid, []byte("hi\n")))
	if sent.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(sent.Body)
		t.Fatalf("stdin %d %s", sent.StatusCode, b)
	}
	_ = sent.Body.Close()
	closed := postRaw(t, srv.URL+"/process.Process/CloseStdin", "application/proto", protoSelector(first.pid))
	_ = closed.Body.Close()
	events, err := readEvents(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	var out strings.Builder
	var code int
	var ended bool
	for _, ev := range events {
		if !ev.err {
			out.Write(ev.data)
		}
		if ev.end {
			ended = true
			code = ev.code
		}
	}
	if !ended || code != 0 || out.String() != "hi" {
		t.Fatalf("out=%q code=%d ended=%v", out.String(), code, ended)
	}

	sleepBody := protoStart("sleep", "30")
	sreq, err := http.NewRequestWithContext(ctx, http.MethodPost, srv.URL+"/process.Process/Start", bytes.NewReader(sleepBody))
	if err != nil {
		t.Fatal(err)
	}
	sreq.Header.Set("Content-Type", "application/proto")
	sresp, err := http.DefaultClient.Do(sreq)
	if err != nil {
		t.Fatal(err)
	}
	defer sresp.Body.Close()
	started, err := readEvent(sresp.Body)
	if err != nil {
		t.Fatal(err)
	}
	sig := postRaw(t, srv.URL+"/process.Process/SendSignal", "application/proto", protoSignal(started.pid, 9))
	if sig.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(sig.Body)
		t.Fatalf("signal %d %s", sig.StatusCode, b)
	}
	_ = sig.Body.Close()
	rest, err := readEvents(sresp.Body)
	if err != nil {
		t.Fatal(err)
	}
	ended = false
	for _, ev := range rest {
		if ev.end {
			ended = true
		}
	}
	if !ended {
		t.Fatal("sleep did not end")
	}
}

func execStarter(ws string) Starter {
	return func(argv []string, dir string, env map[string]string, withStdin bool) (Command, error) {
		cleaned, err := CommandPath(ws, dir)
		if err != nil {
			return Command{}, err
		}
		cmd := exec.Command(argv[0], argv[1:]...)
		cmd.Dir = cleaned
		cmd.Env = os.Environ()
		for k, v := range env {
			cmd.Env = append(cmd.Env, k+"="+v)
		}
		var stdinR *io.PipeReader
		var stdinW *io.PipeWriter
		if withStdin {
			stdinR, stdinW = io.Pipe()
			cmd.Stdin = stdinR
		}
		stdoutR, stdoutW := io.Pipe()
		stderrR, stderrW := io.Pipe()
		cmd.Stdout = stdoutW
		cmd.Stderr = stderrW
		if err := cmd.Start(); err != nil {
			_ = stdoutR.Close()
			_ = stdoutW.Close()
			_ = stderrR.Close()
			_ = stderrW.Close()
			if stdinW != nil {
				_ = stdinW.Close()
			}
			return Command{}, err
		}
		exitCh := make(chan int, 1)
		go func() {
			err := cmd.Wait()
			_ = stdoutW.Close()
			_ = stderrW.Close()
			if stdinR != nil {
				_ = stdinR.Close()
			}
			code := 0
			if err != nil {
				if exitErr, ok := err.(*exec.ExitError); ok {
					code = exitErr.ExitCode()
				} else {
					code = 1
				}
			}
			exitCh <- code
		}()
		return Command{
			PID:    cmd.Process.Pid,
			Stdout: stdoutR,
			Stderr: stderrR,
			Stdin:  stdinW,
			Exit:   exitCh,
			Stop: func() {
				if cmd.Process != nil {
					_ = cmd.Process.Kill()
				}
			},
		}, nil
	}
}

func protoStart(cmd string, args ...string) []byte {
	off := false
	return protoStartStdin(cmd, &off, args...)
}

func protoStartStdin(cmd string, stdin *bool, args ...string) []byte {
	cfg := processConfig{Cmd: cmd, Args: args}
	b := appendMessage(nil, 1, encodeProcessConfig(cfg))
	if stdin != nil {
		v := uint64(0)
		if *stdin {
			v = 1
		}
		b = appendVarint(b, 4, v)
	}
	return b
}

func protoSelector(pid uint32) []byte {
	return appendMessage(nil, 1, appendVarint(nil, 1, uint64(pid)))
}

func protoInput(pid uint32, data []byte) []byte {
	b := protoSelector(pid)
	return appendMessage(b, 2, appendBytes(nil, 1, data))
}

func protoMove(src, dst string) []byte {
	b := appendString(nil, 1, src)
	return appendString(b, 2, dst)
}

func protoSignal(pid uint32, sig uint64) []byte {
	b := protoSelector(pid)
	return appendVarint(b, 2, sig)
}

func runProto(t *testing.T, base string, body []byte) (string, int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, base+"/process.Process/Start", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/proto")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("start %d %s", resp.StatusCode, b)
	}
	events, err := readEvents(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	var out strings.Builder
	code := -1
	for _, ev := range events {
		if len(ev.data) > 0 && !ev.err {
			out.Write(ev.data)
		}
		if ev.end {
			code = ev.code
		}
	}
	return out.String(), code
}

func postRaw(t *testing.T, url, contentType string, body []byte) *http.Response {
	t.Helper()
	return postHeader(t, url, contentType, body, nil)
}

func postHeader(t *testing.T, url, contentType string, body []byte, headers map[string]string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", contentType)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func getRaw(t *testing.T, url string) string {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("get %d %s", resp.StatusCode, b)
	}
	return string(b)
}

func readEvents(r io.Reader) ([]chunk, error) {
	var out []chunk
	for {
		ev, flags, err := readFrame(r)
		if err != nil {
			return nil, err
		}
		if flags&0x02 != 0 {
			return out, nil
		}
		out = append(out, ev)
	}
}

func readEvent(r io.Reader) (chunk, error) {
	for {
		ev, flags, err := readFrame(r)
		if err != nil {
			return chunk{}, err
		}
		if flags&0x02 != 0 {
			return chunk{}, io.EOF
		}
		if ev.keep {
			continue
		}
		return ev, nil
	}
}

func readFrame(r io.Reader) (chunk, byte, error) {
	var hdr [5]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return chunk{}, 0, err
	}
	n := binary.BigEndian.Uint32(hdr[1:])
	payload := make([]byte, n)
	if _, err := io.ReadFull(r, payload); err != nil {
		return chunk{}, 0, err
	}
	if hdr[0]&0x02 != 0 {
		return chunk{}, hdr[0], nil
	}
	return decodeEvent(payload), hdr[0], nil
}

func decodeEvent(b []byte) chunk {
	var c chunk
	_ = walkFields(b, func(num protowire.Number, _ protowire.Type, v []byte) error {
		if num != 1 {
			return nil
		}
		raw, err := asBytes(v)
		if err != nil {
			return err
		}
		return walkFields(raw, func(num protowire.Number, _ protowire.Type, v []byte) error {
			msg, err := asBytes(v)
			if err != nil {
				return err
			}
			switch num {
			case 1:
				c.start = true
				return walkFields(msg, func(num protowire.Number, _ protowire.Type, v []byte) error {
					if num == 1 {
						n, err := asVarint(v)
						c.pid = uint32(n)
						return err
					}
					return nil
				})
			case 2:
				return walkFields(msg, func(num protowire.Number, _ protowire.Type, v []byte) error {
					if num == 2 {
						c.err = true
					}
					if num == 1 || num == 2 {
						data, err := asBytes(v)
						c.data = append(c.data, data...)
						return err
					}
					return nil
				})
			case 3:
				c.end = true
				return walkFields(msg, func(num protowire.Number, _ protowire.Type, v []byte) error {
					if num == 1 {
						n, err := asVarint(v)
						c.code = int(protowire.DecodeZigZag(n))
						return err
					}
					return nil
				})
			case 4:
				c.keep = true
			}
			return nil
		})
	})
	return c
}

// Output that lands just after the exit is kept even when the command last
// wrote long before it.
func TestAwaitOutputCountsQuietFromExit(t *testing.T) {
	p := newProc(1, "", processConfig{}, Command{})
	p.add(chunk{data: []byte("early")})
	p.mu.Lock()
	p.last = time.Now().Add(-30 * time.Second)
	p.mu.Unlock()
	go func() {
		time.Sleep(50 * time.Millisecond)
		p.add(chunk{data: []byte("result")})
	}()
	p.awaitOutput(make(chan struct{}))
	p.finish(0, "")
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, c := range p.chunks {
		if string(c.data) == "result" {
			return
		}
	}
	t.Fatalf("result dropped: %+v", p.chunks)
}

// Input to a process that has ended is refused rather than left blocking on a
// pipe nothing reads.
func TestWriteInputAfterEndIsRefused(t *testing.T) {
	_, w := io.Pipe()
	p := newProc(7, "", processConfig{}, Command{Stdin: w})
	p.finish(0, "")
	s := newProcesses(nil)
	s.byPID[7] = p
	done := make(chan error, 1)
	go func() { done <- s.writeInput(selector{PID: 7}, []byte("x")) }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("input accepted after end")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("writeInput blocked after end")
	}
}
