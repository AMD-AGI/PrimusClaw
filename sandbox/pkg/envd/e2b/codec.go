// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Package e2b serves the E2B envd Connect RPC for processes and files.
// Field numbers follow e2b-dev/infra packages/envd/spec (process.proto, filesystem.proto).
package e2b

import (
	"errors"

	"google.golang.org/protobuf/encoding/protowire"
)

var errShort = errors.New("short protobuf")

type processConfig struct {
	Cmd  string
	Args []string
	Envs map[string]string
	Cwd  string
}

type startRequest struct {
	Process processConfig
	PTY     bool
	Tag     string
	Stdin   *bool
}

type selector struct {
	PID uint32
	Tag string
	Has bool
}

func walkFields(b []byte, fn func(num protowire.Number, typ protowire.Type, v []byte) error) error {
	for len(b) > 0 {
		num, typ, n := protowire.ConsumeTag(b)
		if n < 0 {
			return errShort
		}
		b = b[n:]
		n = protowire.ConsumeFieldValue(num, typ, b)
		if n < 0 {
			return errShort
		}
		if err := fn(num, typ, b[:n]); err != nil {
			return err
		}
		b = b[n:]
	}
	return nil
}

func asBytes(v []byte) ([]byte, error) {
	s, n := protowire.ConsumeBytes(v)
	if n < 0 {
		return nil, errShort
	}
	return s, nil
}

func asString(v []byte) (string, error) {
	b, err := asBytes(v)
	return string(b), err
}

func asVarint(v []byte) (uint64, error) {
	x, n := protowire.ConsumeVarint(v)
	if n < 0 {
		return 0, errShort
	}
	return x, nil
}

func appendString(b []byte, num protowire.Number, s string) []byte {
	b = protowire.AppendTag(b, num, protowire.BytesType)
	return protowire.AppendString(b, s)
}

func appendBytes(b []byte, num protowire.Number, p []byte) []byte {
	b = protowire.AppendTag(b, num, protowire.BytesType)
	return protowire.AppendBytes(b, p)
}

func appendVarint(b []byte, num protowire.Number, v uint64) []byte {
	b = protowire.AppendTag(b, num, protowire.VarintType)
	return protowire.AppendVarint(b, v)
}

func appendMessage(b []byte, num protowire.Number, msg []byte) []byte {
	return appendBytes(b, num, msg)
}

func encodeProcessConfig(cfg processConfig) []byte {
	var b []byte
	if cfg.Cmd != "" {
		b = appendString(b, 1, cfg.Cmd)
	}
	for _, arg := range cfg.Args {
		b = appendString(b, 2, arg)
	}
	for k, v := range cfg.Envs {
		var entry []byte
		entry = appendString(entry, 1, k)
		entry = appendString(entry, 2, v)
		b = appendMessage(b, 3, entry)
	}
	if cfg.Cwd != "" {
		b = appendString(b, 4, cfg.Cwd)
	}
	return b
}

func decodeProcessConfig(b []byte) (processConfig, error) {
	var cfg processConfig
	err := walkFields(b, func(num protowire.Number, _ protowire.Type, v []byte) error {
		switch num {
		case 1:
			s, err := asString(v)
			cfg.Cmd = s
			return err
		case 2:
			s, err := asString(v)
			cfg.Args = append(cfg.Args, s)
			return err
		case 3:
			raw, err := asBytes(v)
			if err != nil {
				return err
			}
			k, val, err := decodeStringPair(raw)
			if err != nil {
				return err
			}
			if cfg.Envs == nil {
				cfg.Envs = map[string]string{}
			}
			cfg.Envs[k] = val
			return nil
		case 4:
			s, err := asString(v)
			cfg.Cwd = s
			return err
		default:
			return nil
		}
	})
	return cfg, err
}

func decodeStringPair(b []byte) (string, string, error) {
	var k, v string
	err := walkFields(b, func(num protowire.Number, _ protowire.Type, raw []byte) error {
		s, err := asString(raw)
		if err != nil {
			return err
		}
		switch num {
		case 1:
			k = s
		case 2:
			v = s
		}
		return nil
	})
	return k, v, err
}

func decodeStartRequest(b []byte) (startRequest, error) {
	var req startRequest
	err := walkFields(b, func(num protowire.Number, _ protowire.Type, v []byte) error {
		switch num {
		case 1:
			raw, err := asBytes(v)
			if err != nil {
				return err
			}
			cfg, err := decodeProcessConfig(raw)
			req.Process = cfg
			return err
		case 2:
			req.PTY = true
			return nil
		case 3:
			s, err := asString(v)
			req.Tag = s
			return err
		case 4:
			n, err := asVarint(v)
			if err != nil {
				return err
			}
			on := n != 0
			req.Stdin = &on
			return nil
		default:
			return nil
		}
	})
	return req, err
}

func decodeSelector(b []byte) (selector, error) {
	var sel selector
	err := walkFields(b, func(num protowire.Number, _ protowire.Type, v []byte) error {
		switch num {
		case 1:
			n, err := asVarint(v)
			sel.PID = uint32(n)
			sel.Has = true
			return err
		case 2:
			s, err := asString(v)
			sel.Tag = s
			sel.Has = true
			return err
		default:
			return nil
		}
	})
	return sel, err
}

func decodeSelectorField(b []byte) (selector, error) {
	var sel selector
	err := walkFields(b, func(num protowire.Number, _ protowire.Type, v []byte) error {
		if num != 1 {
			return nil
		}
		raw, err := asBytes(v)
		if err != nil {
			return err
		}
		decoded, err := decodeSelector(raw)
		sel = decoded
		return err
	})
	return sel, err
}

func encodeStartEvent(pid uint32) []byte {
	inner := appendVarint(nil, 1, uint64(pid))
	event := appendMessage(nil, 1, inner)
	return appendMessage(nil, 1, event)
}

func encodeDataEvent(stderr bool, data []byte) []byte {
	field := protowire.Number(1)
	if stderr {
		field = 2
	}
	dataMsg := appendBytes(nil, field, data)
	event := appendMessage(nil, 2, dataMsg)
	return appendMessage(nil, 1, event)
}

func encodeEndEvent(code int, errText string) []byte {
	var end []byte
	end = protowire.AppendTag(end, 1, protowire.VarintType)
	end = protowire.AppendVarint(end, protowire.EncodeZigZag(int64(code)))
	end = appendVarint(end, 2, 1)
	end = appendString(end, 3, "exited")
	if errText != "" {
		end = appendString(end, 4, errText)
	}
	event := appendMessage(nil, 3, end)
	return appendMessage(nil, 1, event)
}

func encodeKeepAlive() []byte {
	event := appendMessage(nil, 4, nil)
	return appendMessage(nil, 1, event)
}

func encodeProcessInfo(cfg processConfig, pid uint32, tag string) []byte {
	var b []byte
	b = appendMessage(b, 1, encodeProcessConfig(cfg))
	if pid != 0 {
		b = appendVarint(b, 2, uint64(pid))
	}
	if tag != "" {
		b = appendString(b, 3, tag)
	}
	return b
}

func encodeList(items [][]byte) []byte {
	var b []byte
	for _, item := range items {
		b = appendMessage(b, 1, item)
	}
	return b
}
