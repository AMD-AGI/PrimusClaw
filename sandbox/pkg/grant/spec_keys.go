// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"unicode"
	"unicode/utf8"

	runtimev1alpha1 "sigs.k8s.io/agent-sandbox/pkg/apis/runtime/v1alpha1"
)

// CheckSpecKeys rejects a template spec in which one JSON object has two keys
// that encoding/json would match to the same struct field. The decoder matches
// field names case-insensitively (with Unicode simple folding) and keeps the
// last match, so {"workspace":"W2","Workspace":"W1"} decodes as W1 while a
// reader that looks up the exact key sees W2. Refusing such a spec before it is
// decoded leaves every reader with one answer. It checks every object at any
// depth; an empty spec has no keys.
func CheckSpecKeys(spec string) error {
	if spec == "" {
		return nil
	}
	dec := json.NewDecoder(bytes.NewReader([]byte(spec)))
	dec.UseNumber()
	if err := scanValue(dec, "$"); err != nil {
		return err
	}
	if _, err := dec.Token(); !errors.Is(err, io.EOF) {
		return fmt.Errorf("template spec has data after its JSON value")
	}
	return nil
}

// scanValue reads one JSON value from dec and checks the keys of every object in it.
func scanValue(dec *json.Decoder, at string) error {
	tok, err := dec.Token()
	if err != nil {
		return fmt.Errorf("template spec is not JSON: %w", err)
	}
	delim, ok := tok.(json.Delim)
	if !ok {
		return nil
	}
	switch delim {
	case '{':
		seen := map[string]string{}
		for dec.More() {
			keyTok, err := dec.Token()
			if err != nil {
				return fmt.Errorf("template spec is not JSON: %w", err)
			}
			key, _ := keyTok.(string)
			folded := string(foldKey(key))
			if prev, dup := seen[folded]; dup {
				return fmt.Errorf("%s has keys %q and %q, which the JSON decoder reads as one", at, prev, key)
			}
			seen[folded] = key
			if err := scanValue(dec, at+"."+key); err != nil {
				return err
			}
		}
	case '[':
		for i := 0; dec.More(); i++ {
			if err := scanValue(dec, fmt.Sprintf("%s[%d]", at, i)); err != nil {
				return err
			}
		}
	}
	if _, err := dec.Token(); err != nil {
		return fmt.Errorf("template spec is not JSON: %w", err)
	}
	return nil
}

// foldKey folds a key the way encoding/json folds field names when it matches
// them: ASCII letters to upper case, any other rune to upper(lower(r)), which
// maps ſ (U+017F) to S and K (U+212A) to K.
func foldKey(key string) []byte {
	out := make([]byte, 0, len(key))
	for i := 0; i < len(key); {
		if c := key[i]; c < utf8.RuneSelf {
			if 'a' <= c && c <= 'z' {
				c -= 'a' - 'A'
			}
			out = append(out, c)
			i++
			continue
		}
		r, n := utf8.DecodeRuneInString(key[i:])
		out = utf8.AppendRune(out, unicode.ToUpper(unicode.ToLower(r)))
		i += n
	}
	return out
}

// validateSpecKeys holds every template's spec to CheckSpecKeys.
func validateSpecKeys(templates []runtimev1alpha1.GrantTemplate, reason string) error {
	for _, tpl := range templates {
		if err := CheckSpecKeys(tpl.Spec); err != nil {
			return opWrap(http.StatusBadRequest, reason, "template "+tpl.Name+": "+err.Error(), err)
		}
	}
	return nil
}
