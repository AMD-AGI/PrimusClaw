// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package e2b

import (
	"io"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"google.golang.org/protobuf/encoding/protowire"
	e2bapi "sigs.k8s.io/agent-sandbox/pkg/e2b"
)

type fileEntry struct {
	Name        string
	Type        uint32
	Path        string
	Size        int64
	Mode        uint32
	Permissions string
	Owner       string
	Group       string
	Mod         time.Time
	Symlink     string
}

const (
	fileTypeFile = 1
	fileTypeDir  = 2
	fileTypeLink = 3
)

type files struct {
	workspace string
}

func newFiles(workspace string) *files {
	if workspace == "" {
		workspace = "/home/sandbox"
	}
	return &files{workspace: workspace}
}

func (f *files) allow(sealed bool, inputs, outputs []string, method, userPath string) error {
	if !sealed {
		return nil
	}
	if !e2bapi.SealedFileAllows(method, cleanUserPath(userPath), inputs, outputs) {
		return rpcErr("permission_denied", "sealed_denied: path is outside the sealed allow-list")
	}
	return nil
}

func (f *files) resolve(userPath string) (string, error) {
	full, err := SandboxPath(f.workspace, userPath)
	if err != nil {
		return "", rpcErr("invalid_argument", err.Error())
	}
	return full, nil
}

// SandboxPath maps a user path onto the sandbox workspace.
// Absolute paths already inside the workspace stay there. Any other absolute
// path is sandbox-rooted, so "/out/a" is "<workspace>/out/a" and cannot name
// a host path outside the workspace.
func SandboxPath(root, rel string) (string, error) {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	if rel == "" || rel == "/" {
		return rootAbs, nil
	}
	var joined string
	if filepath.IsAbs(rel) {
		abs, err := filepath.Abs(rel)
		if err != nil {
			return "", err
		}
		if abs == rootAbs || strings.HasPrefix(abs, rootAbs+string(filepath.Separator)) {
			joined = abs
		} else {
			joined = filepath.Join(rootAbs, strings.TrimPrefix(filepath.Clean(rel), string(filepath.Separator)))
		}
	} else {
		joined = filepath.Join(rootAbs, rel)
	}
	abs, err := filepath.Abs(joined)
	if err != nil {
		return "", err
	}
	if abs != rootAbs && !strings.HasPrefix(abs, rootAbs+string(filepath.Separator)) {
		return "", os.ErrPermission
	}
	return abs, nil
}

func cleanUserPath(p string) string {
	if p == "" {
		return "/"
	}
	c := path.Clean("/" + strings.TrimPrefix(p, "/"))
	if c == "." {
		return "/"
	}
	return c
}

func (f *files) stat(userPath string) (fileEntry, error) {
	full, err := f.resolve(userPath)
	if err != nil {
		return fileEntry{}, err
	}
	info, err := os.Lstat(full)
	if err != nil {
		return fileEntry{}, fsErr(err)
	}
	return entryFrom(cleanUserPath(userPath), info, full), nil
}

func (f *files) makeDir(userPath string) (fileEntry, error) {
	full, err := f.resolve(userPath)
	if err != nil {
		return fileEntry{}, err
	}
	if err := os.MkdirAll(full, 0o755); err != nil {
		return fileEntry{}, fsErr(err)
	}
	return f.stat(userPath)
}

func (f *files) remove(userPath string) error {
	full, err := f.resolve(userPath)
	if err != nil {
		return err
	}
	if _, err := os.Lstat(full); err != nil {
		return fsErr(err)
	}
	if err := os.RemoveAll(full); err != nil {
		return fsErr(err)
	}
	return nil
}

func (f *files) move(src, dst string) (fileEntry, error) {
	from, err := f.resolve(src)
	if err != nil {
		return fileEntry{}, err
	}
	to, err := f.resolve(dst)
	if err != nil {
		return fileEntry{}, err
	}
	if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
		return fileEntry{}, fsErr(err)
	}
	if err := os.Rename(from, to); err != nil {
		return fileEntry{}, fsErr(err)
	}
	return f.stat(dst)
}

func (f *files) list(userPath string, depth uint32) ([]fileEntry, error) {
	if depth == 0 {
		depth = 1
	}
	full, err := f.resolve(userPath)
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(full)
	if err != nil {
		return nil, fsErr(err)
	}
	if !info.IsDir() {
		return nil, rpcErr("invalid_argument", "path is not a directory")
	}
	var out []fileEntry
	if err := walkDir(full, cleanUserPath(userPath), 1, depth, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func walkDir(full, user string, level, depth uint32, out *[]fileEntry) error {
	entries, err := os.ReadDir(full)
	if err != nil {
		return fsErr(err)
	}
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			return fsErr(err)
		}
		childUser := path.Join(user, e.Name())
		childFull := filepath.Join(full, e.Name())
		*out = append(*out, entryFrom(childUser, info, childFull))
		if info.IsDir() && level < depth {
			if err := walkDir(childFull, childUser, level+1, depth, out); err != nil {
				return err
			}
		}
	}
	return nil
}

func (f *files) write(userPath string, r io.Reader) error {
	full, err := f.resolve(userPath)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		return fsErr(err)
	}
	tmp, err := os.CreateTemp(filepath.Dir(full), ".e2b-upload-*")
	if err != nil {
		return fsErr(err)
	}
	tmpName := tmp.Name()
	ok := false
	defer func() {
		if !ok {
			_ = os.Remove(tmpName)
		}
	}()
	if _, err := io.Copy(tmp, io.LimitReader(r, 32<<20+1)); err != nil {
		_ = tmp.Close()
		return fsErr(err)
	}
	if info, err := tmp.Stat(); err == nil && info.Size() > 32<<20 {
		_ = tmp.Close()
		return rpcErr("resource_exhausted", "file exceeds 32MB")
	}
	if err := tmp.Close(); err != nil {
		return fsErr(err)
	}
	if err := os.Chmod(tmpName, 0o644); err != nil {
		return fsErr(err)
	}
	if err := os.Rename(tmpName, full); err != nil {
		return fsErr(err)
	}
	ok = true
	return nil
}

func (f *files) read(userPath string) (io.ReadCloser, error) {
	full, err := f.resolve(userPath)
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(full)
	if err != nil {
		return nil, fsErr(err)
	}
	if info.IsDir() {
		return nil, rpcErr("invalid_argument", "path is a directory")
	}
	fh, err := os.Open(full)
	if err != nil {
		return nil, fsErr(err)
	}
	return fh, nil
}

func entryFrom(userPath string, info os.FileInfo, full string) fileEntry {
	mode := info.Mode()
	kind := uint32(fileTypeFile)
	switch {
	case mode&os.ModeSymlink != 0:
		kind = fileTypeLink
	case mode.IsDir():
		kind = fileTypeDir
	}
	ent := fileEntry{
		Name:        info.Name(),
		Type:        kind,
		Path:        cleanUserPath(userPath),
		Size:        info.Size(),
		Mode:        uint32(mode.Perm()),
		Permissions: modeString(mode),
		Mod:         info.ModTime().UTC(),
	}
	ent.Owner, ent.Group = ownerGroup(info)
	if kind == fileTypeLink {
		if target, err := os.Readlink(full); err == nil {
			ent.Symlink = target
		}
	}
	if info.Name() == "" || userPath == "/" {
		ent.Name = path.Base(userPath)
	}
	return ent
}

func modeString(m os.FileMode) string {
	bits := []byte("rwxrwxrwx")
	perm := m.Perm()
	for i := 0; i < 9; i++ {
		if perm&(1<<uint(8-i)) == 0 {
			bits[i] = '-'
		}
	}
	return string(bits)
}

func ownerGroup(info os.FileInfo) (string, string) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat == nil {
		return "", ""
	}
	return strconv.FormatUint(uint64(stat.Uid), 10), strconv.FormatUint(uint64(stat.Gid), 10)
}

func fsErr(err error) error {
	if err == nil {
		return nil
	}
	// The operating-system error names the resolved container path.
	if os.IsNotExist(err) {
		return rpcErr("not_found", "path does not exist")
	}
	if os.IsPermission(err) {
		return rpcErr("permission_denied", "path is not permitted")
	}
	if os.IsExist(err) {
		return rpcErr("already_exists", "path already exists")
	}
	return rpcErr("internal", "filesystem request failed")
}

func encodeEntry(ent fileEntry) []byte {
	var b []byte
	if ent.Name != "" {
		b = appendString(b, 1, ent.Name)
	}
	if ent.Type != 0 {
		b = appendVarint(b, 2, uint64(ent.Type))
	}
	if ent.Path != "" {
		b = appendString(b, 3, ent.Path)
	}
	if ent.Size != 0 {
		b = appendVarint(b, 4, uint64(ent.Size))
	}
	if ent.Mode != 0 {
		b = appendVarint(b, 5, uint64(ent.Mode))
	}
	if ent.Permissions != "" {
		b = appendString(b, 6, ent.Permissions)
	}
	if ent.Owner != "" {
		b = appendString(b, 7, ent.Owner)
	}
	if ent.Group != "" {
		b = appendString(b, 8, ent.Group)
	}
	if !ent.Mod.IsZero() {
		var ts []byte
		ts = appendVarint(ts, 1, uint64(ent.Mod.Unix()))
		if ent.Mod.Nanosecond() != 0 {
			ts = appendVarint(ts, 2, uint64(ent.Mod.Nanosecond()))
		}
		b = appendMessage(b, 9, ts)
	}
	if ent.Symlink != "" {
		b = appendString(b, 10, ent.Symlink)
	}
	return b
}

func decodePath(b []byte) (string, error) {
	var p string
	err := walkFields(b, func(num protowire.Number, _ protowire.Type, v []byte) error {
		if num != 1 {
			return nil
		}
		s, err := asString(v)
		p = s
		return err
	})
	return p, err
}

func decodeMove(b []byte) (string, string, error) {
	var src, dst string
	err := walkFields(b, func(num protowire.Number, _ protowire.Type, v []byte) error {
		s, err := asString(v)
		if err != nil {
			return err
		}
		switch num {
		case 1:
			src = s
		case 2:
			dst = s
		}
		return nil
	})
	return src, dst, err
}

func decodeListDir(b []byte) (string, uint32, error) {
	var p string
	var depth uint32
	err := walkFields(b, func(num protowire.Number, _ protowire.Type, v []byte) error {
		switch num {
		case 1:
			s, err := asString(v)
			p = s
			return err
		case 2:
			n, err := asVarint(v)
			depth = uint32(n)
			return err
		default:
			return nil
		}
	})
	return p, depth, err
}
