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
	"k8s.io/apimachinery/pkg/types"
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

// OwnerPolicyStore keeps the owner policy in a ConfigMap. A write validates the
// new policy without side effects, stores it, and then applies it. Every replica
// polls the ConfigMap and applies the stored policy in memory; only the leader
// registers the owner CodeInterpreters, which every replica shares.
type OwnerPolicyStore struct {
	client    ctrlclient.Client
	reader    ctrlclient.Reader
	namespace string
	name      string
	grants    *Service
	leader    func() bool
	now       func() time.Time

	mu sync.Mutex
	// applied is the policy in memory; registered is the policy whose
	// templates this replica registered as leader.
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
	return &OwnerPolicyStore{client: client, reader: reader, namespace: namespace, name: name, grants: grants, leader: leader, now: time.Now}
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
	p.mu.Lock()
	defer p.mu.Unlock()
	out.InSync = p.applied == sha256.Sum256([]byte(raw))
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

// mutate edits the stored policy, validates it without side effects, stores
// it, and then applies it. A conflicting write restarts from the new content.
// A failed apply leaves the stored policy for the next Sync to apply.
func (p *OwnerPolicyStore) mutate(ctx context.Context, edit func(*ownerPolicyDoc) error) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	var raw string
	err := retry.RetryOnConflict(retry.DefaultRetry, func() error {
		cm, err := p.get(ctx)
		if err != nil {
			return err
		}
		doc, err := parseOwnerPolicyDoc(cm.Data[OwnerPolicyKey])
		if err != nil {
			return err
		}
		if err := edit(doc); err != nil {
			return err
		}
		if raw, err = doc.encode(); err != nil {
			return opWrap(http.StatusInternalServerError, "owner_policy_invalid", "", err)
		}
		policy, err := decodeOwnerPolicy(raw)
		if err != nil {
			return err
		}
		if err := p.grants.ValidateOwnerPolicy(ctx, policy); err != nil {
			return err
		}
		if cm.Data == nil {
			cm.Data = map[string]string{}
		}
		cm.Data[OwnerPolicyKey] = raw
		return p.client.Update(ctx, cm)
	})
	if err != nil {
		return err
	}
	if err := p.applyLocked(ctx, raw); err != nil {
		return opWrap(http.StatusInternalServerError, "owner_policy_apply_failed", "the policy is stored and the next sync applies it", err)
	}
	return nil
}

// applyLocked applies raw in memory, and registers its templates when this
// replica is the leader and has not registered raw yet. p.mu must be held.
func (p *OwnerPolicyStore) applyLocked(ctx context.Context, raw string) error {
	sum := sha256.Sum256([]byte(raw))
	register := p.leader() && p.registered != sum
	if !register && p.applied == sum {
		return nil
	}
	policy, err := decodeOwnerPolicy(raw)
	if err == nil {
		err = p.grants.ApplyOwnerPolicy(ctx, policy, register)
	}
	if err != nil {
		p.lastErr = err.Error()
		var op *OpError
		if errors.As(err, &op) && op.Status < http.StatusInternalServerError {
			p.rejected, p.rejectedAt = sum, p.now()
			p.grants.SetOwnerPolicyFault(err)
		}
		return err
	}
	p.applied = sum
	if register {
		p.registered = sum
	}
	p.rejected, p.lastErr = [sha256.Size]byte{}, ""
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

// Sync applies the stored policy when it differs from the applied one, or when
// this replica became leader and has not registered it. A rejected policy is
// tried again after rejectedPolicyRetry.
func (p *OwnerPolicyStore) Sync(ctx context.Context) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	cm, err := p.get(ctx)
	if err != nil {
		return err
	}
	raw := cm.Data[OwnerPolicyKey]
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	if sha256.Sum256([]byte(raw)) == p.rejected && p.now().Sub(p.rejectedAt) < rejectedPolicyRetry {
		return nil
	}
	return p.applyLocked(ctx, raw)
}

// Run calls Sync now and then every interval until ctx ends.
func (p *OwnerPolicyStore) Run(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		if err := p.Sync(ctx); err != nil {
			var op *OpError
			if errors.As(err, &op) && op.Status < http.StatusInternalServerError {
				log.Error("owner policy was rejected; the previous policy stays applied", "configmap", p.name, "error", err)
			} else {
				log.Warn("owner policy sync failed", "configmap", p.name, "error", err)
			}
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
