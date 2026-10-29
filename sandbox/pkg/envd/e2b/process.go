// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package e2b

import (
	"context"
	"io"
	"sync"
	"syscall"
	"time"
)

const maxCapture = 8 << 20

// Command is a started user process. Stdin is nil when the process was started closed.
type Command struct {
	PID    int
	Stdout io.ReadCloser
	Stderr io.ReadCloser
	Stdin  io.WriteCloser
	Exit   <-chan int
	Stop   func()
}

// Starter launches a command. The process must keep running if the caller stops reading.
type Starter func(argv []string, dir string, env map[string]string, withStdin bool) (Command, error)

type chunk struct {
	start bool
	pid   uint32
	data  []byte
	err   bool
	end   bool
	code  int
	text  string
	keep  bool
}

type proc struct {
	pid    int
	tag    string
	cfg    processConfig
	cmd    Command
	mu     sync.Mutex
	cond   *sync.Cond
	chunks []chunk
	bytes  int
	trunc  bool
	exited bool
	code   int
}

func newProc(pid int, tag string, cfg processConfig, cmd Command) *proc {
	p := &proc{pid: pid, tag: tag, cfg: cfg, cmd: cmd}
	p.cond = sync.NewCond(&p.mu)
	return p
}

func (p *proc) add(c chunk) {
	p.mu.Lock()
	if c.data != nil {
		if p.bytes >= maxCapture {
			p.trunc = true
			p.mu.Unlock()
			return
		}
		p.bytes += len(c.data)
	}
	p.chunks = append(p.chunks, c)
	p.cond.Broadcast()
	p.mu.Unlock()
}

func (p *proc) finish(code int, text string) {
	p.mu.Lock()
	if p.trunc && text == "" {
		text = "output truncated"
	}
	p.exited = true
	p.code = code
	p.chunks = append(p.chunks, chunk{end: true, code: code, text: text})
	p.cond.Broadcast()
	p.mu.Unlock()
}

func (p *proc) broadcast() {
	p.mu.Lock()
	p.cond.Broadcast()
	p.mu.Unlock()
}

type processes struct {
	mu    sync.Mutex
	byPID map[int]*proc
	byTag map[string]*proc
	start Starter
}

func newProcesses(start Starter) *processes {
	return &processes{
		byPID: map[int]*proc{},
		byTag: map[string]*proc{},
		start: start,
	}
}

func (s *processes) startOne(req startRequest) (*proc, error) {
	if s.start == nil {
		return nil, rpcErr("unavailable", "process starter is not configured")
	}
	if req.PTY {
		return nil, rpcErr("unimplemented", "pty is not supported")
	}
	if req.Process.Cmd == "" {
		return nil, rpcErr("invalid_argument", "command is required")
	}
	// An omitted stdin field means the caller will not write. Opening a pipe
	// in that case holds the stream open after the process exits.
	withStdin := false
	if req.Stdin != nil {
		withStdin = *req.Stdin
	}
	argv := append([]string{req.Process.Cmd}, req.Process.Args...)
	cmd, err := s.start(argv, req.Process.Cwd, req.Process.Envs, withStdin)
	if err != nil {
		return nil, rpcErr("invalid_argument", err.Error())
	}
	p := newProc(cmd.PID, req.Tag, req.Process, cmd)
	s.mu.Lock()
	if req.Tag != "" {
		if old := s.byTag[req.Tag]; old != nil && !old.done() {
			s.mu.Unlock()
			if cmd.Stdout != nil {
				_ = cmd.Stdout.Close()
			}
			if cmd.Stderr != nil {
				_ = cmd.Stderr.Close()
			}
			if cmd.Stop != nil {
				cmd.Stop()
			}
			return nil, rpcErr("already_exists", "tag is in use")
		}
		s.byTag[req.Tag] = p
	}
	s.byPID[cmd.PID] = p
	s.evictLocked()
	s.mu.Unlock()
	p.add(chunk{start: true, pid: uint32(cmd.PID)})
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		copyPipe(p, cmd.Stdout, false)
		wg.Done()
	}()
	go func() {
		copyPipe(p, cmd.Stderr, true)
		wg.Done()
	}()
	go func() {
		code := 1
		if cmd.Exit != nil {
			code = <-cmd.Exit
		}
		wg.Wait()
		p.finish(code, "")
	}()
	return p, nil
}

func (p *proc) done() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.exited
}

func copyPipe(p *proc, r io.Reader, stderr bool) {
	if r == nil {
		return
	}
	if c, ok := r.(io.Closer); ok {
		defer c.Close()
	}
	buf := make([]byte, 32<<10)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			cp := append([]byte(nil), buf[:n]...)
			p.add(chunk{data: cp, err: stderr})
		}
		if err != nil {
			return
		}
	}
}

func (s *processes) evictLocked() {
	if len(s.byPID) <= 128 {
		return
	}
	for pid, p := range s.byPID {
		if p.done() {
			delete(s.byPID, pid)
			if p.tag != "" && s.byTag[p.tag] == p {
				delete(s.byTag, p.tag)
			}
		}
	}
}

func (s *processes) get(sel selector) (*proc, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if sel.PID != 0 {
		p := s.byPID[int(sel.PID)]
		if p == nil {
			return nil, rpcErr("not_found", "process not found")
		}
		return p, nil
	}
	if sel.Tag != "" {
		p := s.byTag[sel.Tag]
		if p == nil {
			return nil, rpcErr("not_found", "process not found")
		}
		return p, nil
	}
	return nil, rpcErr("invalid_argument", "pid or tag is required")
}

func (s *processes) list() []procInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []procInfo
	for _, p := range s.byPID {
		if p.done() {
			continue
		}
		out = append(out, procInfo{cfg: p.cfg, pid: uint32(p.pid), tag: p.tag})
	}
	return out
}

type procInfo struct {
	cfg processConfig
	pid uint32
	tag string
}

func (s *processes) signal(sel selector, sig syscall.Signal) error {
	p, err := s.get(sel)
	if err != nil {
		return err
	}
	if p.done() {
		return rpcErr("not_found", "process not found")
	}
	if err := syscall.Kill(p.pid, sig); err != nil {
		return rpcErr("not_found", err.Error())
	}
	return nil
}

func (s *processes) writeInput(sel selector, data []byte) error {
	p, err := s.get(sel)
	if err != nil {
		return err
	}
	p.mu.Lock()
	w := p.cmd.Stdin
	p.mu.Unlock()
	if w == nil {
		return rpcErr("failed_precondition", "stdin is closed")
	}
	if _, err := w.Write(data); err != nil {
		return rpcErr("failed_precondition", err.Error())
	}
	return nil
}

func (s *processes) closeStdin(sel selector) error {
	p, err := s.get(sel)
	if err != nil {
		return err
	}
	p.mu.Lock()
	w := p.cmd.Stdin
	p.cmd.Stdin = nil
	p.mu.Unlock()
	if w == nil {
		return nil
	}
	if err := w.Close(); err != nil {
		return rpcErr("internal", err.Error())
	}
	return nil
}

// nextChunk returns the chunk at index i, or a keepalive when nothing new arrived.
// The bool is false when ctx is done and no chunk is waiting.
func (p *proc) nextChunk(ctx context.Context, i int) (chunk, int, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if i < len(p.chunks) {
		return p.chunks[i], i + 1, true
	}
	if p.exited {
		return chunk{end: true, code: p.code, text: p.text()}, i, true
	}
	if ctx.Err() != nil {
		return chunk{}, i, false
	}
	p.cond.Wait()
	if i < len(p.chunks) {
		return p.chunks[i], i + 1, true
	}
	if ctx.Err() != nil {
		return chunk{}, i, false
	}
	if p.exited {
		return chunk{end: true, code: p.code, text: p.text()}, i, true
	}
	return chunk{keep: true}, i, true
}

func (p *proc) text() string {
	if p.trunc {
		return "output truncated"
	}
	return ""
}

// keepAliveInterval is how often a quiet stream emits an event so proxies stay open.
const keepAliveInterval = 5 * time.Second
