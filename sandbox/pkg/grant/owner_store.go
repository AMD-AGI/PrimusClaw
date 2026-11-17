// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package grant

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/fields"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/apimachinery/pkg/watch"
	"k8s.io/client-go/util/retry"
	ctrlclient "sigs.k8s.io/controller-runtime/pkg/client"

	log "sigs.k8s.io/agent-sandbox/pkg/logx"
)

// OwnerPolicyKey is the ConfigMap key that holds the owner policy JSON.
const OwnerPolicyKey = "policy.json"

// ownerPolicyTemplatesKey is the policy field that lists the templates.
const ownerPolicyTemplatesKey = "templates"

// rejectedPolicyRetry is how long a rejected policy waits before it is tried again.
const rejectedPolicyRetry = 5 * time.Minute

// OwnerPolicyConfigMapFromEnv returns the owner policy ConfigMap name from
// E2B_OWNER_POLICY_CONFIGMAP, or "" when it is not set.
func OwnerPolicyConfigMapFromEnv() string {
	return strings.TrimSpace(os.Getenv("E2B_OWNER_POLICY_CONFIGMAP"))
}

// OwnerPolicyStore keeps the owner policy in a ConfigMap. A write validates,
// applies and registers the new policy, then stores it. Every replica can write.
// Followers sync the stored policy into memory; the leader also registers
// templates that an external edit stored without registration.
type OwnerPolicyStore struct {
	client    ctrlclient.Client
	reader    ctrlclient.Reader
	watcher   ctrlclient.WithWatch
	namespace string
	name      string
	grants    *Service
	leader    func() bool
	now       func() time.Time

	writeMu sync.Mutex // serializes mutate and Sync
	mu      sync.Mutex // guards applied, registered, rejected, lastErr
	// applied is the policy in memory; registered is the policy whose
	// templates this replica registered.
	applied    [sha256.Size]byte
	registered [sha256.Size]byte
	rejected   [sha256.Size]byte
	rejectedAt time.Time
	lastErr    string
}

// NewOwnerPolicyStore returns a store for ConfigMap namespace/name. leader
// reports whether this replica holds the leader lease.
func NewOwnerPolicyStore(client ctrlclient.Client, reader ctrlclient.Reader, namespace, name string, grants *Service, leader func() bool) *OwnerPolicyStore {
	if reader == nil {
		reader = client
	}
	if leader == nil {
		leader = func() bool { return true }
	}
	p := &OwnerPolicyStore{client: client, reader: reader, namespace: namespace, name: name, grants: grants, leader: leader, now: time.Now}
	if w, ok := client.(ctrlclient.WithWatch); ok {
		p.watcher = w
	}
	return p
}

// WithWatcher attaches a client used to watch the policy ConfigMap.
func (p *OwnerPolicyStore) WithWatcher(w ctrlclient.WithWatch) *OwnerPolicyStore {
	p.watcher = w
	return p
}

// OwnerPolicyTemplates is the stored template list. InSync reports whether the
// answering replica has applied the stored policy; Error is the last apply error.
type OwnerPolicyTemplates struct {
	Templates []TemplateRequest `json:"templates"`
	InSync    bool              `json:"inSync"`
	Error     string            `json:"error,omitempty"`
}

// ownerPolicyDoc is the policy JSON with its templates split out. Fields other
// than templates are kept as stored.
type ownerPolicyDoc struct {
	fields    map[string]json.RawMessage
	templates []json.RawMessage
	parsed    []TemplateRequest
}

// parseOwnerPolicyDoc decodes raw policy JSON. A field that differs from
// "templates" only in case is rejected, so one list holds every template.
func parseOwnerPolicyDoc(raw string) (*ownerPolicyDoc, error) {
	doc := &ownerPolicyDoc{fields: map[string]json.RawMessage{}}
	if strings.TrimSpace(raw) != "" {
		if err := json.Unmarshal([]byte(raw), &doc.fields); err != nil {
			return nil, opWrap(http.StatusInternalServerError, "owner_policy_invalid", "stored owner policy is not a JSON object", err)
		}
	}
	for key := range doc.fields {
		if key != ownerPolicyTemplatesKey && strings.EqualFold(key, ownerPolicyTemplatesKey) {
			return nil, opErr(http.StatusInternalServerError, "owner_policy_invalid", "stored owner policy has field "+key+"; use templates")
		}
	}
	if t, ok := doc.fields[ownerPolicyTemplatesKey]; ok {
		if err := json.Unmarshal(t, &doc.templates); err != nil {
			return nil, opWrap(http.StatusInternalServerError, "owner_policy_invalid", "stored owner policy templates are not a list", err)
		}
	}
	for _, t := range doc.templates {
		var tpl TemplateRequest
		if err := json.Unmarshal(t, &tpl); err != nil {
			return nil, opWrap(http.StatusInternalServerError, "owner_policy_invalid", "stored owner policy template is not an object", err)
		}
		doc.parsed = append(doc.parsed, tpl)
	}
	return doc, nil
}

// docFromPolicy builds a document from a decoded policy, normalizing field names.
func docFromPolicy(policy OwnerPolicy) (*ownerPolicyDoc, error) {
	b, err := json.Marshal(policy)
	if err != nil {
		return nil, opWrap(http.StatusInternalServerError, "owner_policy_invalid", "", err)
	}
	return parseOwnerPolicyDoc(string(b))
}

// loadDoc returns the stored document. A wrong-case templates field is rebuilt
// from a case-insensitive decode so role and quotas are kept. Only a document
// that cannot be decoded at all is replaced with an empty policy for repair.
func loadDoc(raw string) (*ownerPolicyDoc, error) {
	doc, err := parseOwnerPolicyDoc(raw)
	if err == nil {
		return doc, nil
	}
	if policy, decErr := decodeOwnerPolicy(raw); decErr == nil {
		return docFromPolicy(policy)
	}
	var op *OpError
	if errors.As(err, &op) && op.Reason == "owner_policy_invalid" {
		return &ownerPolicyDoc{fields: map[string]json.RawMessage{}}, nil
	}
	return nil, err
}

// index returns the position of template name, or -1.
func (d *ownerPolicyDoc) index(name string) int {
	for i, tpl := range d.parsed {
		if tpl.Name == name {
			return i
		}
	}
	return -1
}

// encode returns the policy JSON with the current templates.
func (d *ownerPolicyDoc) encode() (string, error) {
	t, err := json.Marshal(d.templates)
	if err != nil {
		return "", err
	}
	d.fields[ownerPolicyTemplatesKey] = t
	b, err := json.MarshalIndent(d.fields, "", "  ")
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// Templates returns the templates of the stored policy.
func (p *OwnerPolicyStore) Templates(ctx context.Context) (OwnerPolicyTemplates, error) {
	cm, err := p.get(ctx)
	if err != nil {
		return OwnerPolicyTemplates{}, err
	}
	raw := cm.Data[OwnerPolicyKey]
	doc, err := parseOwnerPolicyDoc(raw)
	if err != nil {
		return OwnerPolicyTemplates{}, err
	}
	out := OwnerPolicyTemplates{Templates: doc.parsed}
	if out.Templates == nil {
		out.Templates = []TemplateRequest{}
	}
	sum := sha256.Sum256([]byte(raw))
	p.mu.Lock()
	defer p.mu.Unlock()
	// A leader is in sync only after it has registered the stored templates.
	out.InSync = p.applied == sum && p.lastErr == "" && (!p.leader() || p.registered == sum)
	if !out.InSync {
		out.Error = p.lastErr
	}
	return out, nil
}

// PutTemplate adds tpl to the policy, or replaces the template of the same name.
func (p *OwnerPolicyStore) PutTemplate(ctx context.Context, tpl TemplateRequest) error {
	if tpl.Name == "" {
		return opErr(http.StatusBadRequest, "invalid_template", "template name is required")
	}
	if spec := bytes.TrimSpace(tpl.Spec); len(spec) == 0 || string(spec) == "null" {
		return opErr(http.StatusBadRequest, "invalid_template", "template spec is required")
	}
	entry, err := json.Marshal(tpl)
	if err != nil {
		return opWrap(http.StatusBadRequest, "invalid_template", "", err)
	}
	return p.mutate(ctx, func(d *ownerPolicyDoc) error {
		if i := d.index(tpl.Name); i >= 0 {
			d.templates[i] = entry
			d.parsed[i] = tpl
			return nil
		}
		d.templates = append(d.templates, entry)
		d.parsed = append(d.parsed, tpl)
		return nil
	})
}

// DeleteTemplate removes template name from the policy.
func (p *OwnerPolicyStore) DeleteTemplate(ctx context.Context, name string) error {
	return p.mutate(ctx, func(d *ownerPolicyDoc) error {
		i := d.index(name)
		if i < 0 {
			return opErr(http.StatusNotFound, "template_not_found", name)
		}
		if len(d.templates) == 1 {
			return opErr(http.StatusBadRequest, "invalid_owner_policy", "at least one template is required")
		}
		d.templates = append(d.templates[:i], d.templates[i+1:]...)
		d.parsed = append(d.parsed[:i], d.parsed[i+1:]...)
		return nil
	})
}

// mutate edits the stored policy: validate, apply (and register), then store.
// A rejected apply leaves the ConfigMap unchanged. A failed apply or store
// rolls CodeInterpreters and memory back to the stored document.
func (p *OwnerPolicyStore) mutate(ctx context.Context, edit func(*ownerPolicyDoc) error) error {
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		cm, err := p.get(ctx)
		if err != nil {
			return err
		}
		doc, err := loadDoc(cm.Data[OwnerPolicyKey])
		if err != nil {
			return err
		}
		if err := edit(doc); err != nil {
			return err
		}
		raw, err := doc.encode()
		if err != nil {
			return opWrap(http.StatusInternalServerError, "owner_policy_invalid", "", err)
		}
		policy, err := decodeOwnerPolicy(raw)
		if err != nil {
			return err
		}
		cfg, err := p.grants.prepareOwnerPolicy(ctx, policy)
		if err != nil {
			return err
		}
		if err := p.grants.applyOwnerConfig(ctx, cfg, true); err != nil {
			p.recordApplyErr(raw, err, false)
			return err
		}
		sum := sha256.Sum256([]byte(raw))
		p.mu.Lock()
		p.applied, p.registered = sum, sum
		p.rejected, p.lastErr = [sha256.Size]byte{}, ""
		p.mu.Unlock()
		if cm.Data == nil {
			cm.Data = map[string]string{}
		}
		cm.Data[OwnerPolicyKey] = raw
		return p.client.Update(ctx, cm)
	})
	if err != nil {
		p.rollback(ctx)
		return err
	}
	return nil
}

// rollback forces a re-apply and re-register of the stored policy so partial
// CodeInterpreter writes from a failed mutate are undone. writeMu must be held.
func (p *OwnerPolicyStore) rollback(ctx context.Context) {
	cm, err := p.get(ctx)
	if err != nil {
		return
	}
	p.mu.Lock()
	p.applied = [sha256.Size]byte{}
	p.registered = [sha256.Size]byte{}
	p.mu.Unlock()
	_ = p.applyLocked(ctx, cm.Data[OwnerPolicyKey], true)
}

// recordApplyErr records a failed apply of raw.
func (p *OwnerPolicyStore) recordApplyErr(raw string, err error, faultIfUnapplied bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.lastErr = err.Error()
	var op *OpError
	if errors.As(err, &op) && op.Status < http.StatusInternalServerError {
		p.rejected, p.rejectedAt = sha256.Sum256([]byte(raw)), p.now()
		if faultIfUnapplied && p.grants.owner.Load() == nil {
			p.grants.SetOwnerPolicyFault(err)
		}
	}
}

// applyLocked applies raw in memory, and registers its templates when force is
// set, or when this replica is the leader and has not registered raw yet.
// writeMu must be held.
func (p *OwnerPolicyStore) applyLocked(ctx context.Context, raw string, force bool) error {
	sum := sha256.Sum256([]byte(raw))
	p.mu.Lock()
	register := force || (p.leader() && p.registered != sum)
	skip := !register && p.applied == sum
	p.mu.Unlock()
	if skip {
		return nil
	}
	policy, err := decodeOwnerPolicy(raw)
	if err != nil {
		p.mu.Lock()
		p.lastErr = err.Error()
		p.mu.Unlock()
		return err
	}
	cfg, err := p.grants.prepareOwnerPolicy(ctx, policy)
	if err == nil {
		err = p.grants.applyOwnerConfig(ctx, cfg, register)
	}
	if err != nil {
		p.recordApplyErr(raw, err, true)
		return err
	}
	p.mu.Lock()
	p.applied = sum
	if register {
		p.registered = sum
	}
	p.rejected, p.lastErr = [sha256.Size]byte{}, ""
	p.mu.Unlock()
	return nil
}

// decodeOwnerPolicy decodes raw policy JSON.
func decodeOwnerPolicy(raw string) (OwnerPolicy, error) {
	var policy OwnerPolicy
	if err := json.Unmarshal([]byte(raw), &policy); err != nil {
		return OwnerPolicy{}, opWrap(http.StatusBadRequest, "invalid_owner_policy", "owner policy is not JSON", err)
	}
	return policy, nil
}

// get reads the policy ConfigMap.
func (p *OwnerPolicyStore) get(ctx context.Context) (*corev1.ConfigMap, error) {
	cm := &corev1.ConfigMap{}
	if err := p.reader.Get(ctx, types.NamespacedName{Namespace: p.namespace, Name: p.name}, cm); err != nil {
		return nil, opWrap(http.StatusInternalServerError, "owner_policy_unavailable", p.name, err)
	}
	return cm, nil
}

// MarkApplied records raw as the policy this replica applied in memory at startup.
func (p *OwnerPolicyStore) MarkApplied(raw string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.applied = sha256.Sum256([]byte(raw))
}

// MarkRegistered records raw as the policy whose templates this replica registered.
func (p *OwnerPolicyStore) MarkRegistered(raw string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.registered = sha256.Sum256([]byte(raw))
}

// Sync applies the stored policy when it differs from the applied one, or when
// this replica became leader and has not registered it. A rejected policy is
// tried again after rejectedPolicyRetry.
func (p *OwnerPolicyStore) Sync(ctx context.Context) error {
	p.writeMu.Lock()
	defer p.writeMu.Unlock()
	cm, err := p.get(ctx)
	if err != nil {
		return err
	}
	raw := cm.Data[OwnerPolicyKey]
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	p.mu.Lock()
	skipRejected := sha256.Sum256([]byte(raw)) == p.rejected && p.now().Sub(p.rejectedAt) < rejectedPolicyRetry
	p.mu.Unlock()
	if skipRejected {
		return nil
	}
	return p.applyLocked(ctx, raw, false)
}

// Run syncs now, watches the ConfigMap for changes, and resyncs every interval
// as a backup. When the client cannot watch, it falls back to polling interval.
func (p *OwnerPolicyStore) Run(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		interval = 15 * time.Second
	}
	for {
		if err := p.Sync(ctx); err != nil {
			p.logSyncErr(err)
		}
		if err := p.watchOnce(ctx, interval); err != nil && ctx.Err() == nil {
			log.Warn("owner policy watch ended", "configmap", p.name, "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
}

// logSyncErr logs a Sync failure.
func (p *OwnerPolicyStore) logSyncErr(err error) {
	var op *OpError
	if errors.As(err, &op) && op.Status < http.StatusInternalServerError {
		log.Error("owner policy was rejected; the previous policy stays applied", "configmap", p.name, "error", err)
		return
	}
	log.Warn("owner policy sync failed", "configmap", p.name, "error", err)
}

// watchOnce watches the named policy ConfigMap until ctx ends, the watch
// closes, or interval elapses. Without a watcher it polls once per interval.
func (p *OwnerPolicyStore) watchOnce(ctx context.Context, interval time.Duration) error {
	if p.watcher == nil {
		return p.pollOnce(ctx, interval)
	}
	watcher, err := p.watcher.Watch(ctx, &corev1.ConfigMapList{},
		ctrlclient.InNamespace(p.namespace),
		ctrlclient.MatchingFieldsSelector{Selector: fields.OneTermEqualSelector("metadata.name", p.name)},
	)
	if err != nil {
		return p.pollOnce(ctx, interval)
	}
	defer watcher.Stop()
	timer := time.NewTimer(interval)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			return nil
		case ev, ok := <-watcher.ResultChan():
			if !ok {
				return errors.New("watch closed")
			}
			if ev.Type == watch.Error {
				return errors.New("watch error")
			}
			cm, ok := ev.Object.(*corev1.ConfigMap)
			if !ok || cm.Name != p.name {
				continue
			}
			if err := p.Sync(ctx); err != nil {
				p.logSyncErr(err)
			}
		}
	}
}

// pollOnce waits for interval then returns so Run can Sync again.
func (p *OwnerPolicyStore) pollOnce(ctx context.Context, interval time.Duration) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(interval):
		return nil
	}
}
