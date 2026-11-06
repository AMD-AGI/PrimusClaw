// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package envd

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

func uploadThrough(t *testing.T, s *Server, contentType string, body []byte) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/files", bytes.NewReader(body))
	req.Header.Set("Content-Type", contentType)
	rec := httptest.NewRecorder()
	s.handleFileUpload(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("upload: %d %s", rec.Code, rec.Body.String())
	}
}

// The /api/files uploads take the process umask the way a file a command
// writes does: under the umask 002 a sandbox runs with, a file is 0664 and the
// directories made for it 0775. They were 0644 and 0755 whatever the umask.
// Under umask 022 they are still 0644 and 0755, and a mode the caller names is
// used as before.
func TestFileUploadsCreateUnderTheProcessUmask(t *testing.T) {
	for _, c := range []struct {
		umask     int
		file, dir os.FileMode
		name      string
	}{
		{0o002, 0o664, 0o775, "umask 002"},
		{0o022, 0o644, 0o755, "umask 022"},
	} {
		t.Run(c.name, func(t *testing.T) {
			// The umask is process-wide: this test must not run in parallel.
			old := syscall.Umask(c.umask)
			t.Cleanup(func() { syscall.Umask(old) })
			ws := t.TempDir()
			s := &Server{workspace: ws}

			j, err := json.Marshal(FileUploadJSONRequest{Path: "json/a.txt", Content: base64.StdEncoding.EncodeToString([]byte("hi"))})
			if err != nil {
				t.Fatal(err)
			}
			uploadThrough(t, s, "application/json", j)
			j, err = json.Marshal(FileUploadJSONRequest{Path: "json/x.sh", Content: base64.StdEncoding.EncodeToString([]byte("x")), Mode: "700"})
			if err != nil {
				t.Fatal(err)
			}
			uploadThrough(t, s, "application/json", j)

			var form bytes.Buffer
			mw := multipart.NewWriter(&form)
			if err := mw.WriteField("path", "multi/part/b.txt"); err != nil {
				t.Fatal(err)
			}
			fw, err := mw.CreateFormFile("file", "b.txt")
			if err != nil {
				t.Fatal(err)
			}
			if _, err := fw.Write([]byte("hi")); err != nil {
				t.Fatal(err)
			}
			if err := mw.Close(); err != nil {
				t.Fatal(err)
			}
			uploadThrough(t, s, mw.FormDataContentType(), form.Bytes())

			for path, want := range map[string]os.FileMode{
				"json":             c.dir,
				"json/a.txt":       c.file,
				"json/x.sh":        0o700,
				"multi":            c.dir,
				"multi/part":       c.dir,
				"multi/part/b.txt": c.file,
			} {
				info, err := os.Stat(filepath.Join(ws, path))
				if err != nil {
					t.Fatal(err)
				}
				if got := info.Mode().Perm(); got != want {
					t.Errorf("%s: mode %04o, want %04o", path, got, want)
				}
			}
		})
	}
}
