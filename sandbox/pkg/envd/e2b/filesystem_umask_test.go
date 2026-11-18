// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package e2b

import (
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// withUmask sets the process umask for the rest of the test. The umask is
// process-wide, so a test that calls it must not run in parallel.
func withUmask(t *testing.T, mask int) {
	t.Helper()
	old := syscall.Umask(mask)
	t.Cleanup(func() { syscall.Umask(old) })
}

func permOf(t *testing.T, path string) os.FileMode {
	t.Helper()
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	return info.Mode().Perm()
}

// What the filesystem service creates takes the process umask the way a file a
// command writes does: under the umask 002 a sandbox runs with, an upload is
// 0664 and every directory made for it, by MakeDir or by a write or a move
// into a new directory, is 0775. They were 0644 and 0755 whatever the umask.
// Under umask 022 they are still 0644 and 0755.
func TestFilesystemCreatesUnderTheProcessUmask(t *testing.T) {
	for _, c := range []struct {
		umask     int
		file, dir os.FileMode
		name      string
	}{
		{0o002, 0o664, 0o775, "umask 002"},
		{0o022, 0o644, 0o755, "umask 022"},
	} {
		t.Run(c.name, func(t *testing.T) {
			withUmask(t, c.umask)
			ws := t.TempDir()
			mux := http.NewServeMux()
			Mount(mux, ws, execStarter(ws))
			srv := httptest.NewServer(mux)
			defer srv.Close()
			ok := func(what string, r *http.Response) {
				t.Helper()
				body, _ := io.ReadAll(r.Body)
				_ = r.Body.Close()
				if r.StatusCode != http.StatusOK {
					t.Fatalf("%s: %d %s", what, r.StatusCode, body)
				}
			}

			ok("upload", postRaw(t, srv.URL+"/files?path=out/a.txt", "text/plain", []byte("hi")))
			ok("mkdir", postRaw(t, srv.URL+"/filesystem.Filesystem/MakeDir", "application/proto",
				appendString(nil, 1, "made/dir")))
			ok("move", postRaw(t, srv.URL+"/filesystem.Filesystem/Move", "application/proto",
				protoMove("out/a.txt", "moved/b.txt")))
			ok("overwrite", postRaw(t, srv.URL+"/files?path=moved/b.txt", "text/plain", []byte("again")))

			for path, want := range map[string]os.FileMode{
				"out":         c.dir,
				"made":        c.dir,
				"made/dir":    c.dir,
				"moved":       c.dir,
				"moved/b.txt": c.file,
			} {
				if got := permOf(t, filepath.Join(ws, path)); got != want {
					t.Errorf("%s: mode %04o, want %04o", path, got, want)
				}
			}
		})
	}
}
