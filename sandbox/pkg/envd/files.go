// SPDX-FileCopyrightText: The Kubernetes Authors / kubernetes-sigs/agent-sandbox
// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package envd

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const maxUploadSize = 32 << 20 // 32 MB

// handleFiles routes file operations based on method.
func (s *Server) handleFiles(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		s.handleFileUpload(w, r)
	case http.MethodGet:
		// Check if it's a path listing or download
		path := r.URL.Query().Get("path")
		filePath := strings.TrimPrefix(r.URL.Path, "/api/files")
		filePath = strings.TrimPrefix(filePath, "/")

		if filePath == "" || path != "" {
			// Directory listing
			if path == "" {
				path = "."
			}
			s.handleFileListing(w, r, path)
		} else {
			s.handleFileDownload(w, r, filePath)
		}
	case http.MethodDelete:
		filePath := strings.TrimPrefix(r.URL.Path, "/api/files/")
		s.handleFileDelete(w, r, filePath)
	default:
		httpError(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

// handleFileUpload handles POST /api/files
func (s *Server) handleFileUpload(w http.ResponseWriter, r *http.Request) {
	ct := r.Header.Get("Content-Type")
	mediaType, _, _ := mime.ParseMediaType(ct)

	switch mediaType {
	case "application/json":
		s.uploadJSON(w, r)
	case "multipart/form-data":
		s.uploadMultipart(w, r)
	default:
		httpError(w, "unsupported Content-Type; use application/json or multipart/form-data", http.StatusBadRequest)
	}
}

func (s *Server) uploadJSON(w http.ResponseWriter, r *http.Request) {
	var req FileUploadJSONRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		httpError(w, "invalid JSON: "+err.Error(), http.StatusBadRequest)
		return
	}

	content, err := base64.StdEncoding.DecodeString(req.Content)
	if err != nil {
		httpError(w, "invalid base64 content: "+err.Error(), http.StatusBadRequest)
		return
	}

	abs, err := sanitizePath(s.workspace, req.Path)
	if err != nil {
		httpError(w, err.Error(), http.StatusBadRequest)
		return
	}

	if err := os.MkdirAll(filepath.Dir(abs), 0755); err != nil {
		httpError(w, "failed to create directories: "+err.Error(), http.StatusInternalServerError)
		return
	}

	mode := os.FileMode(0644)
	if req.Mode != "" {
		if m, err := strconv.ParseUint(req.Mode, 8, 32); err == nil {
			mode = os.FileMode(m)
		}
	}

	if err := os.WriteFile(abs, content, mode); err != nil {
		httpError(w, "failed to write file: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusCreated)
}

func (s *Server) uploadMultipart(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadSize)
	if err := r.ParseMultipartForm(maxUploadSize); err != nil {
		httpError(w, "failed to parse multipart: "+err.Error(), http.StatusBadRequest)
		return
	}

	destPath := r.FormValue("path")
	if destPath == "" {
		httpError(w, "path field is required", http.StatusBadRequest)
		return
	}

	abs, err := sanitizePath(s.workspace, destPath)
	if err != nil {
		httpError(w, err.Error(), http.StatusBadRequest)
		return
	}

	file, _, err := r.FormFile("file")
	if err != nil {
		httpError(w, "file field is required: "+err.Error(), http.StatusBadRequest)
		return
	}
	defer file.Close()

	if err := os.MkdirAll(filepath.Dir(abs), 0755); err != nil {
		httpError(w, "failed to create directories: "+err.Error(), http.StatusInternalServerError)
		return
	}

	dst, err := os.Create(abs)
	if err != nil {
		httpError(w, "failed to create file: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer dst.Close()

	if _, err := io.Copy(dst, file); err != nil {
		httpError(w, "failed to write file: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusCreated)
}

// handleFileDownload handles GET /api/files/{path}
func (s *Server) handleFileDownload(w http.ResponseWriter, r *http.Request, relPath string) {
	abs, err := sanitizePath(s.workspace, relPath)
	if err != nil {
		httpError(w, err.Error(), http.StatusBadRequest)
		return
	}

	info, err := os.Stat(abs)
	if err != nil {
		if os.IsNotExist(err) {
			httpError(w, "file not found", http.StatusNotFound)
		} else {
			httpError(w, "stat error: "+err.Error(), http.StatusInternalServerError)
		}
		return
	}

	if info.IsDir() {
		httpError(w, "path is a directory; use ?path= for listing", http.StatusBadRequest)
		return
	}

	// Stream the file
	f, err := os.Open(abs)
	if err != nil {
		httpError(w, "failed to open file: "+err.Error(), http.StatusInternalServerError)
		return
	}
	defer f.Close()

	// Infer content type
	ext := filepath.Ext(abs)
	ct := mime.TypeByExtension(ext)
	if ct == "" {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Content-Disposition", fmt.Sprintf(`attachment; filename="%s"`, filepath.Base(abs)))
	w.Header().Set("Content-Length", strconv.FormatInt(info.Size(), 10))

	if _, err := io.Copy(w, f); err != nil {
		// Can't send error at this point, connection may be broken
		return
	}
}

// handleFileListing handles GET /api/files?path=.
func (s *Server) handleFileListing(w http.ResponseWriter, r *http.Request, relPath string) {
	abs, err := sanitizePath(s.workspace, relPath)
	if err != nil {
		httpError(w, err.Error(), http.StatusBadRequest)
		return
	}

	entries, err := os.ReadDir(abs)
	if err != nil {
		if os.IsNotExist(err) {
			httpError(w, "directory not found", http.StatusNotFound)
		} else {
			httpError(w, "read error: "+err.Error(), http.StatusInternalServerError)
		}
		return
	}

	files := make([]FileInfo, 0, len(entries))
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			continue
		}
		files = append(files, FileInfo{
			Name:  e.Name(),
			Size:  info.Size(),
			Mode:  info.Mode().String(),
			IsDir: e.IsDir(),
			MTime: info.ModTime().UTC().Format("2006-01-02T15:04:05Z"),
		})
	}

	writeJSON(w, http.StatusOK, FileListResponse{Files: files})
}

// handleFileDelete handles DELETE /api/files/{path}
func (s *Server) handleFileDelete(w http.ResponseWriter, r *http.Request, relPath string) {
	if relPath == "" || relPath == "." || relPath == "/" {
		httpError(w, "cannot delete workspace root", http.StatusBadRequest)
		return
	}

	abs, err := sanitizePath(s.workspace, relPath)
	if err != nil {
		httpError(w, err.Error(), http.StatusBadRequest)
		return
	}

	// Extra guard: prevent deleting the workspace itself
	wsAbs, _ := filepath.Abs(s.workspace)
	if abs == wsAbs {
		httpError(w, "cannot delete workspace root", http.StatusBadRequest)
		return
	}

	if err := os.RemoveAll(abs); err != nil {
		httpError(w, "failed to delete: "+err.Error(), http.StatusInternalServerError)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}
