// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package e2b

import (
	"io"
	"math/rand/v2"
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

// newDirPerm and newFilePerm are what a directory or file created here asks
// for, left for the process umask to narrow, as mkdir(1) and a shell
// redirection do: under umask 022 that is 0755 and 0644, and under the umask
// 002 a sandbox runs with it is 0775 and 0664, so a file written into a
// directory operators share through a setgid group is writable by that group,
// as one a command in the sandbox writes there is.
const (
	newDirPerm  os.FileMode = 0o777
	newFilePerm os.FileMode = 0o666
)

// createTemp is os.CreateTemp with perm in place of its fixed 0600, so the
// file an upload is renamed into place from has the mode any new file gets.
func createTemp(dir, prefix string, perm os.FileMode) (*os.File, error) {
	for range 10000 {
		name := filepath.Join(dir, prefix+strconv.FormatUint(uint64(rand.Uint32()), 10))
		f, err := os.OpenFile(name, os.O_RDWR|os.O_CREATE|os.O_EXCL, perm)
		if os.IsExist(err) {
			continue
		}
		return f, err
	}
	return nil, &os.PathError{Op: "createtemp", Path: filepath.Join(dir, prefix+"*"), Err: os.ErrExist}
}

// files serves the E2B filesystem API for one request.
//
// An unsealed request has the reach of the commands the sandbox runs: envd's
// file calls run under the uid its commands get, and a command can already
// read or write any path that uid can. The one credential envd holds that its
// commands do not is egress.EnvDProxyGID, an iptables marker group no file is
// meant to carry; envd can only add it with CAP_SETGID, that is when it runs as
// root, and its commands then run as root too, with the container's
// CAP_DAC_OVERRIDE (envd drops only CAP_NET_ADMIN, CAP_NET_RAW and CAP_SETGID
// from the bounding set), so the group opens nothing to the file API that a
// command cannot open. So an unsealed request is served with E2B's semantics:
// an absolute path is that path, and a relative one is taken from the
// workspace, the directory commands start in. files.write("/tmp/x") then
// writes the /tmp/x that commands.run("cat /tmp/x") reads.
//
// A sealed request (a granted sandbox whose Router token carries an allow-list)
// may not run commands at all, and the allow-list is the only thing that
// bounds it. Its paths name a tree rooted at the workspace: the grant's "/in"
// is "<workspace>/in". A sealed path that leaves that tree is refused with an
// error that says so; it is never quietly mapped somewhere else.
type files struct {
	workspace string
	sealed    bool
}

func newFiles(workspace string) *files {
	if workspace == "" {
		workspace = "/home/sandbox"
	}
	return &files{workspace: workspace}
}

// scoped is the view of the filesystem one request is served from.
func (f *files) scoped(sealed bool) *files {
	return &files{workspace: f.workspace, sealed: sealed}
}

func (f *files) allow(inputs, outputs []string, method, userPath string) error {
	if !f.sealed {
		return nil
	}
	if !e2bapi.SealedFileAllows(method, cleanUserPath(userPath), inputs, outputs) {
		return rpcErr("permission_denied", "sealed_denied: path is outside the sealed allow-list")
	}
	return nil
}

// resolve gives the container path a user path names, and the path the
// response reports for it: the user's own sandbox-rooted path when sealed,
// the absolute container path otherwise.
func (f *files) resolve(userPath string) (string, string, error) {
	if !f.sealed {
		full, err := CommandPath(f.workspace, userPath)
		if err != nil {
			return "", "", rpcErr("invalid_argument", "path cannot be resolved")
		}
		return full, full, nil
	}
	full, err := SandboxPath(f.workspace, userPath)
	if err != nil {
		return "", "", rpcErr("permission_denied", "path escapes the sandbox root")
	}
	return full, cleanUserPath(userPath), nil
}

// CommandPath resolves a path the way a command in the sandbox would: an
// absolute path is itself, a relative one is taken from the workspace, and an
// empty one is the workspace.
func CommandPath(workspace, p string) (string, error) {
	root, err := filepath.Abs(workspace)
	if err != nil {
		return "", err
	}
	if p == "" {
		return root, nil
	}
	if filepath.IsAbs(p) {
		return filepath.Clean(p), nil
	}
	return filepath.Join(root, p), nil
}

// SandboxPath maps a sealed request's path onto the tree rooted at the
// workspace. Absolute paths already inside the workspace stay there; any other
// absolute path is read from the workspace, so "/out/a" is "<workspace>/out/a".
// A path that would leave the workspace returns os.ErrPermission.
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
	inside, err := filepath.Rel(rootAbs, abs)
	if err != nil || !filepath.IsLocal(inside) {
		return "", os.ErrPermission
	}
	return filepath.Join(rootAbs, inside), nil
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
	full, shown, err := f.resolve(userPath)
	if err != nil {
		return fileEntry{}, err
	}
	info, err := os.Lstat(full)
	if err != nil {
		return fileEntry{}, fsErr(err)
	}
	return entryFrom(shown, info, full), nil
}

func (f *files) makeDir(userPath string) (fileEntry, error) {
	full, _, err := f.resolve(userPath)
	if err != nil {
		return fileEntry{}, err
	}
	if err := os.MkdirAll(full, newDirPerm); err != nil {
		return fileEntry{}, fsErr(err)
	}
	return f.stat(userPath)
}

func (f *files) remove(userPath string) error {
	full, _, err := f.resolve(userPath)
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
	from, _, err := f.resolve(src)
	if err != nil {
		return fileEntry{}, err
	}
	to, _, err := f.resolve(dst)
	if err != nil {
		return fileEntry{}, err
	}
	if err := os.MkdirAll(filepath.Dir(to), newDirPerm); err != nil {
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
	full, shown, err := f.resolve(userPath)
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
	if err := walkDir(full, shown, 1, depth, &out); err != nil {
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
	full, _, err := f.resolve(userPath)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(full), newDirPerm); err != nil {
		return fsErr(err)
	}
	tmp, err := createTemp(filepath.Dir(full), ".e2b-upload-", newFilePerm)
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
	if err := os.Rename(tmpName, full); err != nil {
		return fsErr(err)
	}
	ok = true
	return nil
}

func (f *files) read(userPath string) (io.ReadCloser, error) {
	full, _, err := f.resolve(userPath)
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
