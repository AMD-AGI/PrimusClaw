// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package e2b

import (
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"strconv"
	"strings"
	"syscall"
	"time"

	"google.golang.org/protobuf/encoding/protowire"
	e2bapi "sigs.k8s.io/agent-sandbox/pkg/e2b"
)

type rpcError struct {
	code    string
	message string
	status  int
}

func rpcErr(code, message string) *rpcError {
	return &rpcError{code: code, message: message, status: statusOf(code)}
}

func (e *rpcError) Error() string { return e.message }

func statusOf(code string) int {
	switch code {
	case "invalid_argument", "failed_precondition":
		return http.StatusBadRequest
	case "not_found":
		return http.StatusNotFound
	case "already_exists":
		return http.StatusConflict
	case "permission_denied":
		return http.StatusForbidden
	case "resource_exhausted":
		return http.StatusRequestEntityTooLarge
	case "unimplemented":
		return http.StatusNotImplemented
	case "unavailable":
		return http.StatusServiceUnavailable
	default:
		return http.StatusInternalServerError
	}
}

type handler struct {
	files *files
	procs *processes
}

// Mount registers E2B Connect RPCs and HTTP /files on mux.
// Requests still pass through EnvD's JWT middleware.
func Mount(mux *http.ServeMux, workspace string, start Starter) {
	h := &handler{files: newFiles(workspace), procs: newProcesses(start)}
	mux.Handle("/process.Process/", h)
	mux.Handle("/filesystem.Filesystem/", h)
	mux.HandleFunc("/files", h.serveFiles)
	mux.HandleFunc("/files/", h.serveFiles)
}

func (h *handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeRPCError(w, rpcErr("unimplemented", "method not allowed"))
		return
	}
	switch r.URL.Path {
	case "/process.Process/List":
		h.serveList(w, r)
	case "/process.Process/Start":
		h.serveStart(w, r)
	case "/process.Process/Connect":
		h.serveConnect(w, r)
	case "/process.Process/Update":
		h.serveUpdate(w, r)
	case "/process.Process/SendInput":
		h.serveSendInput(w, r)
	case "/process.Process/StreamInput":
		h.serveStreamInput(w, r)
	case "/process.Process/SendSignal":
		h.serveSignal(w, r)
	case "/process.Process/CloseStdin":
		h.serveCloseStdin(w, r)
	case "/filesystem.Filesystem/Stat":
		h.serveStat(w, r)
	case "/filesystem.Filesystem/MakeDir":
		h.serveMakeDir(w, r)
	case "/filesystem.Filesystem/Move":
		h.serveMove(w, r)
	case "/filesystem.Filesystem/ListDir":
		h.serveListDir(w, r)
	case "/filesystem.Filesystem/Remove":
		h.serveRemove(w, r)
	default:
		writeRPCError(w, rpcErr("unimplemented", "method is not supported"))
	}
}

func (h *handler) rejectProcess(r *http.Request) error {
	if sealed, _, _ := policyOf(r); sealed {
		return rpcErr("permission_denied", "sealed_denied: process execution is not allowed")
	}
	return nil
}

func (h *handler) serveList(w http.ResponseWriter, r *http.Request) {
	if err := h.rejectProcess(r); err != nil {
		writeRPCError(w, err)
		return
	}
	_, jsonMode, err := readBody(r)
	if err != nil {
		writeRPCError(w, err)
		return
	}
	items := h.procs.list()
	if jsonMode {
		payload, err := json.Marshal(map[string]any{"processes": listJSON(items)})
		if err != nil {
			writeRPCError(w, err)
			return
		}
		writeUnary(w, true, payload)
		return
	}
	var msgs [][]byte
	for _, item := range items {
		msgs = append(msgs, encodeProcessInfo(item.cfg, item.pid, item.tag))
	}
	writeUnary(w, false, encodeList(msgs))
}

func (h *handler) serveStart(w http.ResponseWriter, r *http.Request) {
	if err := h.rejectProcess(r); err != nil {
		writeRPCError(w, err)
		return
	}
	body, jsonMode, err := readBody(r)
	if err != nil {
		writeRPCError(w, err)
		return
	}
	req, err := decodeStart(body, jsonMode)
	if err != nil {
		writeRPCError(w, err)
		return
	}
	proc, err := h.procs.startOne(req)
	if err != nil {
		writeRPCError(w, err)
		return
	}
	h.writeStream(w, r, proc, jsonMode)
}

func (h *handler) serveConnect(w http.ResponseWriter, r *http.Request) {
	if err := h.rejectProcess(r); err != nil {
		writeRPCError(w, err)
		return
	}
	body, jsonMode, err := readBody(r)
	if err != nil {
		writeRPCError(w, err)
		return
	}
	sel, err := decodeSelectorMessage(body, jsonMode)
	if err != nil {
		writeRPCError(w, err)
		return
	}
	proc, err := h.procs.get(sel)
	if err != nil {
		writeRPCError(w, err)
		return
	}
	h.writeStream(w, r, proc, jsonMode)
}

func (h *handler) serveUpdate(w http.ResponseWriter, r *http.Request) {
	if err := h.rejectProcess(r); err != nil {
		writeRPCError(w, err)
		return
	}
	body, jsonMode, err := readBody(r)
	if err != nil {
		writeRPCError(w, err)
		return
	}
	sel, err := decodeSelectorMessage(body, jsonMode)
	if err != nil {
		writeRPCError(w, err)
		return
	}
	if _, err := h.procs.get(sel); err != nil {
		writeRPCError(w, err)
		return
	}
	writeUnary(w, jsonMode, emptyOK(jsonMode))
}

func (h *handler) serveSendInput(w http.ResponseWriter, r *http.Request) {
	if err := h.rejectProcess(r); err != nil {
		writeRPCError(w, err)
		return
	}
	body, jsonMode, err := readBody(r)
	if err != nil {
		writeRPCError(w, err)
		return
	}
	sel, data, err := decodeSendInput(body, jsonMode)
	if err != nil {
		writeRPCError(w, err)
		return
	}
	if err := h.procs.writeInput(sel, data); err != nil {
		writeRPCError(w, err)
		return
	}
	writeUnary(w, jsonMode, emptyOK(jsonMode))
}

func (h *handler) serveCloseStdin(w http.ResponseWriter, r *http.Request) {
	if err := h.rejectProcess(r); err != nil {
		writeRPCError(w, err)
		return
	}
	body, jsonMode, err := readBody(r)
	if err != nil {
		writeRPCError(w, err)
		return
	}
	sel, err := decodeSelectorMessage(body, jsonMode)
	if err != nil {
		writeRPCError(w, err)
		return
	}
	if err := h.procs.closeStdin(sel); err != nil {
		writeRPCError(w, err)
		return
	}
	writeUnary(w, jsonMode, emptyOK(jsonMode))
}

func (h *handler) serveSignal(w http.ResponseWriter, r *http.Request) {
	if err := h.rejectProcess(r); err != nil {
		writeRPCError(w, err)
		return
	}
	body, jsonMode, err := readBody(r)
	if err != nil {
		writeRPCError(w, err)
		return
	}
	sel, sig, err := decodeSignal(body, jsonMode)
	if err != nil {
		writeRPCError(w, err)
		return
	}
	if sig == 0 {
		writeRPCError(w, rpcErr("invalid_argument", "signal is required"))
		return
	}
	if err := h.procs.signal(sel, sig); err != nil {
		writeRPCError(w, err)
		return
	}
	writeUnary(w, jsonMode, emptyOK(jsonMode))
}

func (h *handler) serveStreamInput(w http.ResponseWriter, r *http.Request) {
	if err := h.rejectProcess(r); err != nil {
		writeRPCError(w, err)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 8<<20+1))
	if err != nil {
		writeRPCError(w, err)
		return
	}
	if len(body) > 8<<20 {
		writeRPCError(w, rpcErr("resource_exhausted", "message exceeds 8MB"))
		return
	}
	jsonMode := strings.Contains(strings.ToLower(r.Header.Get("Content-Type")), "json")
	var current selector
	apply := func(msg []byte) error {
		sel, data, pty, keep, err := decodeStreamInput(msg, jsonMode)
		if err != nil {
			return err
		}
		if keep {
			return nil
		}
		if pty {
			return rpcErr("unimplemented", "pty is not supported")
		}
		if sel.Has {
			current = sel
		}
		if data == nil {
			return nil
		}
		if !current.Has {
			return rpcErr("invalid_argument", "pid or tag is required")
		}
		return h.procs.writeInput(current, data)
	}
	ct := strings.ToLower(r.Header.Get("Content-Type"))
	if strings.Contains(ct, "connect+") || strings.Contains(ct, "grpc") || len(body) == 0 {
		err = readEnvelopes(body, apply)
	} else {
		err = apply(body)
	}
	if err != nil {
		writeRPCError(w, err)
		return
	}
	writeUnary(w, jsonMode, emptyOK(jsonMode))
}

func (h *handler) serveStat(w http.ResponseWriter, r *http.Request) {
	h.servePathEntry(w, r, http.MethodGet, func(p string) (fileEntry, error) {
		return h.files.stat(p)
	})
}

func (h *handler) serveMakeDir(w http.ResponseWriter, r *http.Request) {
	h.servePathEntry(w, r, http.MethodPost, func(p string) (fileEntry, error) {
		return h.files.makeDir(p)
	})
}

func (h *handler) serveRemove(w http.ResponseWriter, r *http.Request) {
	body, jsonMode, err := readBody(r)
	if err != nil {
		writeRPCError(w, err)
		return
	}
	p, err := decodeUserPath(body, jsonMode)
	if err != nil {
		writeRPCError(w, err)
		return
	}
	if err := h.allow(r, http.MethodPost, p); err != nil {
		writeRPCError(w, err)
		return
	}
	if err := h.files.remove(p); err != nil {
		writeRPCError(w, err)
		return
	}
	writeUnary(w, jsonMode, emptyOK(jsonMode))
}

func (h *handler) serveMove(w http.ResponseWriter, r *http.Request) {
	body, jsonMode, err := readBody(r)
	if err != nil {
		writeRPCError(w, err)
		return
	}
	src, dst, err := decodeMoveRequest(body, jsonMode)
	if err != nil {
		writeRPCError(w, err)
		return
	}
	if err := h.allow(r, http.MethodPost, src); err != nil {
		writeRPCError(w, err)
		return
	}
	if err := h.allow(r, http.MethodPost, dst); err != nil {
		writeRPCError(w, err)
		return
	}
	ent, err := h.files.move(src, dst)
	if err != nil {
		writeRPCError(w, err)
		return
	}
	writeEntry(w, jsonMode, ent)
}

func (h *handler) serveListDir(w http.ResponseWriter, r *http.Request) {
	body, jsonMode, err := readBody(r)
	if err != nil {
		writeRPCError(w, err)
		return
	}
	p, depth, err := decodeListRequest(body, jsonMode)
	if err != nil {
		writeRPCError(w, err)
		return
	}
	if err := h.allow(r, http.MethodGet, p); err != nil {
		writeRPCError(w, err)
		return
	}
	entries, err := h.files.list(p, depth)
	if err != nil {
		writeRPCError(w, err)
		return
	}
	if jsonMode {
		payload, err := json.Marshal(map[string]any{"entries": entriesJSON(entries)})
		if err != nil {
			writeRPCError(w, err)
			return
		}
		writeUnary(w, true, payload)
		return
	}
	var b []byte
	for _, ent := range entries {
		b = appendMessage(b, 1, encodeEntry(ent))
	}
	writeUnary(w, false, b)
}

func (h *handler) servePathEntry(w http.ResponseWriter, r *http.Request, method string, fn func(string) (fileEntry, error)) {
	body, jsonMode, err := readBody(r)
	if err != nil {
		writeRPCError(w, err)
		return
	}
	p, err := decodeUserPath(body, jsonMode)
	if err != nil {
		writeRPCError(w, err)
		return
	}
	if err := h.allow(r, method, p); err != nil {
		writeRPCError(w, err)
		return
	}
	ent, err := fn(p)
	if err != nil {
		writeRPCError(w, err)
		return
	}
	writeEntry(w, jsonMode, ent)
}

func (h *handler) allow(r *http.Request, method, userPath string) error {
	sealed, inputs, outputs := policyOf(r)
	return h.files.allow(sealed, inputs, outputs, method, userPath)
}

func (h *handler) serveFiles(w http.ResponseWriter, r *http.Request) {
	userPath := r.URL.Query().Get("path")
	if userPath == "" {
		userPath = strings.TrimPrefix(r.URL.Path, "/files")
	}
	switch r.Method {
	case http.MethodGet, http.MethodHead:
		if err := h.allow(r, http.MethodGet, userPath); err != nil {
			writeRPCError(w, err)
			return
		}
		fh, err := h.files.read(userPath)
		if err != nil {
			writeRPCError(w, err)
			return
		}
		defer fh.Close()
		w.Header().Set("Content-Type", "application/octet-stream")
		if r.Method == http.MethodHead {
			w.WriteHeader(http.StatusOK)
			return
		}
		_, _ = io.Copy(w, fh)
	case http.MethodPost:
		if err := h.allow(r, http.MethodPost, userPath); err != nil {
			writeRPCError(w, err)
			return
		}
		src, cleanup, err := uploadBody(r)
		if err != nil {
			writeRPCError(w, err)
			return
		}
		defer cleanup()
		if err := h.files.write(userPath, src); err != nil {
			writeRPCError(w, err)
			return
		}
		ent, err := h.files.stat(userPath)
		if err != nil {
			writeRPCError(w, err)
			return
		}
		payload, err := json.Marshal([]map[string]any{httpEntry(ent)})
		if err != nil {
			writeRPCError(w, err)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(payload)
	default:
		writeRPCError(w, rpcErr("unimplemented", "method not allowed"))
	}
}

func (h *handler) writeStream(w http.ResponseWriter, r *http.Request, p *proc, jsonMode bool) {
	if jsonMode {
		w.Header().Set("Content-Type", "application/connect+json")
	} else {
		w.Header().Set("Content-Type", "application/connect+proto")
	}
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	ctx := r.Context()
	done := make(chan struct{})
	defer close(done)
	go func() {
		ticker := time.NewTicker(keepAliveInterval)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ctx.Done():
				p.broadcast()
				return
			case <-ticker.C:
				p.broadcast()
			}
		}
	}()
	index := 0
	for {
		item, next, ok := p.nextChunk(ctx, index)
		if !ok {
			return
		}
		if err := writeEnvelope(w, 0, eventPayload(item, jsonMode)); err != nil {
			return
		}
		if flusher != nil {
			flusher.Flush()
		}
		if item.end {
			_ = writeEnvelope(w, 0x02, []byte("{}"))
			if flusher != nil {
				flusher.Flush()
			}
			return
		}
		index = next
	}
}

func uploadBody(r *http.Request) (io.Reader, func(), error) {
	noop := func() {}
	ct := r.Header.Get("Content-Type")
	media, params, err := mime.ParseMediaType(ct)
	if err == nil && strings.HasPrefix(media, "multipart/") {
		mr := multipart.NewReader(r.Body, params["boundary"])
		for {
			part, err := mr.NextPart()
			if err == io.EOF {
				break
			}
			if err != nil {
				return nil, noop, rpcErr("invalid_argument", err.Error())
			}
			if part.FormName() == "file" || part.FileName() != "" {
				return part, func() { _ = part.Close() }, nil
			}
		}
		return nil, noop, rpcErr("invalid_argument", "multipart file is required")
	}
	return io.LimitReader(r.Body, 32<<20+1), noop, nil
}

// policyOf returns the sealed allow-list from the verified Router token.
// X-Sandbox-Sealed and the path headers are ignored.
func policyOf(r *http.Request) (bool, []string, []string) {
	policy, ok := e2bapi.PolicyFrom(r.Context())
	if !ok || !policy.Sealed {
		return false, nil, nil
	}
	return true, policy.Inputs, policy.Outputs
}

func readBody(r *http.Request) ([]byte, bool, error) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 8<<20+1))
	if err != nil {
		return nil, false, err
	}
	if len(body) > 8<<20 {
		return nil, false, rpcErr("resource_exhausted", "message exceeds 8MB")
	}
	ct := strings.ToLower(r.Header.Get("Content-Type"))
	jsonMode := strings.Contains(ct, "json")
	if strings.Contains(ct, "connect+") || strings.Contains(ct, "grpc") {
		if len(body) == 0 {
			return nil, jsonMode, nil
		}
		msg, err := firstEnvelope(body)
		return msg, jsonMode, err
	}
	return body, jsonMode, nil
}

func firstEnvelope(b []byte) ([]byte, error) {
	msg, _, err := takeEnvelope(b)
	return msg, err
}

func readEnvelopes(b []byte, fn func([]byte) error) error {
	for len(b) > 0 {
		msg, rest, err := takeEnvelope(b)
		if err != nil {
			return err
		}
		flags := b[0]
		b = rest
		if flags&0x02 != 0 {
			return nil
		}
		if err := fn(msg); err != nil {
			return err
		}
	}
	return nil
}

func takeEnvelope(b []byte) ([]byte, []byte, error) {
	if len(b) < 5 {
		return nil, nil, rpcErr("invalid_argument", "short connect envelope")
	}
	if b[0]&1 != 0 {
		return nil, nil, rpcErr("unimplemented", "compressed messages are not supported")
	}
	n := binary.BigEndian.Uint32(b[1:5])
	if int(n) > len(b)-5 {
		return nil, nil, rpcErr("invalid_argument", "short connect envelope")
	}
	return b[5 : 5+n], b[5+n:], nil
}

func writeEnvelope(w io.Writer, flags byte, payload []byte) error {
	var hdr [5]byte
	hdr[0] = flags
	binary.BigEndian.PutUint32(hdr[1:], uint32(len(payload)))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	_, err := w.Write(payload)
	return err
}

func writeUnary(w http.ResponseWriter, jsonMode bool, payload []byte) {
	if jsonMode {
		w.Header().Set("Content-Type", "application/json")
	} else {
		w.Header().Set("Content-Type", "application/proto")
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(payload)
}

func writeEntry(w http.ResponseWriter, jsonMode bool, ent fileEntry) {
	if jsonMode {
		payload, err := json.Marshal(map[string]any{"entry": entryJSON(ent)})
		if err != nil {
			writeRPCError(w, err)
			return
		}
		writeUnary(w, true, payload)
		return
	}
	writeUnary(w, false, appendMessage(nil, 1, encodeEntry(ent)))
}

func emptyOK(jsonMode bool) []byte {
	if jsonMode {
		return []byte("{}")
	}
	return nil
}

func writeRPCError(w http.ResponseWriter, err error) {
	re, ok := err.(*rpcError)
	if !ok || re == nil {
		re = rpcErr("internal", err.Error())
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(re.status)
	_ = json.NewEncoder(w).Encode(map[string]string{"code": re.code, "message": re.message})
}

func eventPayload(c chunk, jsonMode bool) []byte {
	if !jsonMode {
		switch {
		case c.keep:
			return encodeKeepAlive()
		case c.start:
			return encodeStartEvent(c.pid)
		case c.end:
			return encodeEndEvent(c.code, c.text)
		default:
			return encodeDataEvent(c.err, c.data)
		}
	}
	switch {
	case c.keep:
		return []byte(`{"event":{"keepalive":{}}}`)
	case c.start:
		payload, _ := json.Marshal(map[string]any{"event": map[string]any{"start": map[string]any{"pid": c.pid}}})
		return payload
	case c.end:
		end := map[string]any{"exitCode": c.code, "exited": true, "status": "exited"}
		if c.text != "" {
			end["error"] = c.text
		}
		payload, _ := json.Marshal(map[string]any{"event": map[string]any{"end": end}})
		return payload
	default:
		field := "stdout"
		if c.err {
			field = "stderr"
		}
		payload, _ := json.Marshal(map[string]any{
			"event": map[string]any{"data": map[string]any{field: base64.StdEncoding.EncodeToString(c.data)}},
		})
		return payload
	}
}

func listJSON(items []procInfo) []map[string]any {
	out := make([]map[string]any, 0, len(items))
	for _, item := range items {
		out = append(out, map[string]any{
			"config": map[string]any{"cmd": item.cfg.Cmd, "args": item.cfg.Args, "envs": item.cfg.Envs, "cwd": item.cfg.Cwd},
			"pid":    item.pid,
			"tag":    item.tag,
		})
	}
	return out
}

// httpEntry is the JSON object POST /files returns. The SDK reads an array of these.
func httpEntry(ent fileEntry) map[string]any {
	kind := "file"
	if ent.Type == fileTypeDir {
		kind = "directory"
	}
	return map[string]any{"path": ent.Path, "name": ent.Name, "type": kind}
}

func entryJSON(ent fileEntry) map[string]any {
	m := map[string]any{
		"name":         ent.Name,
		"type":         typeName(ent.Type),
		"path":         ent.Path,
		"size":         strconv.FormatInt(ent.Size, 10),
		"mode":         ent.Mode,
		"permissions":  ent.Permissions,
		"owner":        ent.Owner,
		"group":        ent.Group,
		"modifiedTime": ent.Mod.Format(time.RFC3339Nano),
	}
	if ent.Symlink != "" {
		m["symlinkTarget"] = ent.Symlink
	}
	return m
}

func entriesJSON(entries []fileEntry) []map[string]any {
	out := make([]map[string]any, 0, len(entries))
	for _, ent := range entries {
		out = append(out, entryJSON(ent))
	}
	return out
}

func typeName(kind uint32) string {
	switch kind {
	case fileTypeFile:
		return "FILE_TYPE_FILE"
	case fileTypeDir:
		return "FILE_TYPE_DIRECTORY"
	case fileTypeLink:
		return "FILE_TYPE_SYMLINK"
	default:
		return "FILE_TYPE_UNSPECIFIED"
	}
}

func decodeStart(body []byte, jsonMode bool) (startRequest, error) {
	if jsonMode {
		var raw struct {
			Process struct {
				Cmd  string            `json:"cmd"`
				Args []string          `json:"args"`
				Envs map[string]string `json:"envs"`
				Cwd  string            `json:"cwd"`
			} `json:"process"`
			Pty   json.RawMessage `json:"pty"`
			Tag   string          `json:"tag"`
			Stdin *bool           `json:"stdin"`
		}
		if len(body) > 0 {
			if err := json.Unmarshal(body, &raw); err != nil {
				return startRequest{}, rpcErr("invalid_argument", err.Error())
			}
		}
		req := startRequest{
			Process: processConfig{Cmd: raw.Process.Cmd, Args: raw.Process.Args, Envs: raw.Process.Envs, Cwd: raw.Process.Cwd},
			Tag:     raw.Tag,
			Stdin:   raw.Stdin,
		}
		if len(raw.Pty) > 0 && string(raw.Pty) != "null" {
			req.PTY = true
		}
		return req, nil
	}
	return decodeStartRequest(body)
}

func decodeSelectorMessage(body []byte, jsonMode bool) (selector, error) {
	if jsonMode {
		var raw struct {
			Process struct {
				Pid uint32 `json:"pid"`
				Tag string `json:"tag"`
			} `json:"process"`
		}
		if len(body) > 0 {
			if err := json.Unmarshal(body, &raw); err != nil {
				return selector{}, rpcErr("invalid_argument", err.Error())
			}
		}
		sel := selector{PID: raw.Process.Pid, Tag: raw.Process.Tag}
		sel.Has = sel.PID != 0 || sel.Tag != ""
		return sel, nil
	}
	return decodeSelectorField(body)
}

func decodeUserPath(body []byte, jsonMode bool) (string, error) {
	if jsonMode {
		var raw struct {
			Path string `json:"path"`
		}
		if len(body) > 0 {
			if err := json.Unmarshal(body, &raw); err != nil {
				return "", rpcErr("invalid_argument", err.Error())
			}
		}
		return raw.Path, nil
	}
	return decodePath(body)
}

func decodeMoveRequest(body []byte, jsonMode bool) (string, string, error) {
	if jsonMode {
		var raw struct {
			Source      string `json:"source"`
			Destination string `json:"destination"`
		}
		if err := json.Unmarshal(body, &raw); err != nil {
			return "", "", rpcErr("invalid_argument", err.Error())
		}
		return raw.Source, raw.Destination, nil
	}
	return decodeMove(body)
}

func decodeListRequest(body []byte, jsonMode bool) (string, uint32, error) {
	if jsonMode {
		var raw struct {
			Path  string `json:"path"`
			Depth uint32 `json:"depth"`
		}
		if len(body) > 0 {
			if err := json.Unmarshal(body, &raw); err != nil {
				return "", 0, rpcErr("invalid_argument", err.Error())
			}
		}
		return raw.Path, raw.Depth, nil
	}
	return decodeListDir(body)
}

func decodeSendInput(body []byte, jsonMode bool) (selector, []byte, error) {
	if jsonMode {
		var raw struct {
			Process struct {
				Pid uint32 `json:"pid"`
				Tag string `json:"tag"`
			} `json:"process"`
			Input struct {
				Stdin string `json:"stdin"`
				Pty   string `json:"pty"`
			} `json:"input"`
		}
		if err := json.Unmarshal(body, &raw); err != nil {
			return selector{}, nil, rpcErr("invalid_argument", err.Error())
		}
		if raw.Input.Pty != "" {
			return selector{}, nil, rpcErr("unimplemented", "pty is not supported")
		}
		data, err := base64.StdEncoding.DecodeString(raw.Input.Stdin)
		if err != nil {
			return selector{}, nil, rpcErr("invalid_argument", err.Error())
		}
		sel := selector{PID: raw.Process.Pid, Tag: raw.Process.Tag, Has: true}
		return sel, data, nil
	}
	var sel selector
	var data []byte
	err := walkFields(body, func(num protowire.Number, _ protowire.Type, v []byte) error {
		raw, err := asBytes(v)
		if err != nil {
			return err
		}
		switch num {
		case 1:
			decoded, err := decodeSelector(raw)
			sel = decoded
			return err
		case 2:
			decoded, pty, err := decodeInput(raw)
			if pty {
				return rpcErr("unimplemented", "pty is not supported")
			}
			data = decoded
			return err
		default:
			return nil
		}
	})
	return sel, data, err
}

func decodeInput(body []byte) ([]byte, bool, error) {
	var data []byte
	var pty bool
	err := walkFields(body, func(num protowire.Number, _ protowire.Type, v []byte) error {
		switch num {
		case 1:
			b, err := asBytes(v)
			data = b
			return err
		case 2:
			pty = true
			return nil
		default:
			return nil
		}
	})
	return data, pty, err
}

func decodeSignal(body []byte, jsonMode bool) (selector, syscall.Signal, error) {
	if jsonMode {
		var raw struct {
			Process struct {
				Pid uint32 `json:"pid"`
				Tag string `json:"tag"`
			} `json:"process"`
			Signal any `json:"signal"`
		}
		if err := json.Unmarshal(body, &raw); err != nil {
			return selector{}, 0, rpcErr("invalid_argument", err.Error())
		}
		sel := selector{PID: raw.Process.Pid, Tag: raw.Process.Tag, Has: true}
		return sel, signalFromJSON(raw.Signal), nil
	}
	var sel selector
	var sig uint64
	err := walkFields(body, func(num protowire.Number, _ protowire.Type, v []byte) error {
		switch num {
		case 1:
			raw, err := asBytes(v)
			if err != nil {
				return err
			}
			decoded, err := decodeSelector(raw)
			sel = decoded
			return err
		case 2:
			n, err := asVarint(v)
			sig = n
			return err
		default:
			return nil
		}
	})
	if err != nil {
		return selector{}, 0, err
	}
	return sel, syscall.Signal(sig), nil
}

func signalFromJSON(v any) syscall.Signal {
	switch n := v.(type) {
	case float64:
		return syscall.Signal(n)
	case string:
		switch n {
		case "SIGNAL_SIGKILL":
			return syscall.SIGKILL
		case "SIGNAL_SIGTERM":
			return syscall.SIGTERM
		}
	}
	return 0
}

func decodeStreamInput(body []byte, jsonMode bool) (selector, []byte, bool, bool, error) {
	if jsonMode {
		var raw map[string]json.RawMessage
		if len(body) == 0 {
			return selector{}, nil, false, true, nil
		}
		if err := json.Unmarshal(body, &raw); err != nil {
			return selector{}, nil, false, false, rpcErr("invalid_argument", err.Error())
		}
		if _, ok := raw["keepalive"]; ok {
			return selector{}, nil, false, true, nil
		}
		if start, ok := raw["start"]; ok {
			var ev struct {
				Process struct {
					Pid uint32 `json:"pid"`
					Tag string `json:"tag"`
				} `json:"process"`
			}
			if err := json.Unmarshal(start, &ev); err != nil {
				return selector{}, nil, false, false, rpcErr("invalid_argument", err.Error())
			}
			sel := selector{PID: ev.Process.Pid, Tag: ev.Process.Tag}
			sel.Has = sel.PID != 0 || sel.Tag != ""
			return sel, nil, false, false, nil
		}
		if data, ok := raw["data"]; ok {
			var ev struct {
				Input struct {
					Stdin string `json:"stdin"`
					Pty   string `json:"pty"`
				} `json:"input"`
			}
			if err := json.Unmarshal(data, &ev); err != nil {
				return selector{}, nil, false, false, rpcErr("invalid_argument", err.Error())
			}
			if ev.Input.Pty != "" {
				return selector{}, nil, true, false, nil
			}
			decoded, err := base64.StdEncoding.DecodeString(ev.Input.Stdin)
			if err != nil {
				return selector{}, nil, false, false, rpcErr("invalid_argument", err.Error())
			}
			return selector{}, decoded, false, false, nil
		}
		return selector{}, nil, false, true, nil
	}
	var sel selector
	var data []byte
	var pty, keep bool
	err := walkFields(body, func(num protowire.Number, _ protowire.Type, v []byte) error {
		raw, err := asBytes(v)
		if err != nil {
			return err
		}
		switch num {
		case 1:
			decoded, err := decodeSelectorField(raw)
			sel = decoded
			return err
		case 2:
			var input []byte
			innerErr := walkFields(raw, func(num protowire.Number, _ protowire.Type, v []byte) error {
				if num != 2 {
					return nil
				}
				msg, err := asBytes(v)
				if err != nil {
					return err
				}
				decoded, isPty, err := decodeInput(msg)
				input = decoded
				pty = isPty
				return err
			})
			data = input
			return innerErr
		case 3:
			keep = true
			return nil
		default:
			return nil
		}
	})
	return sel, data, pty, keep, err
}
