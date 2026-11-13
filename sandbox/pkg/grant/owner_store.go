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

// OwnerPolicyConfigMapFromEnv returns the owner policy ConfigMap name from
// E2B_OWNER_POLICY_CONFIGMAP, or "" when it is not set.
func OwnerPolicyConfigMapFromEnv() string {
	return strings.TrimSpace(os.Getenv("E2B_OWNER_POLICY_CONFIGMAP"))
}

// OwnerPolicyStore keeps the owner policy in a ConfigMap. Writes apply the new
// policy before they persist it, so a rejected policy is never stored. Every
// replica polls the ConfigMap and applies a changed policy.
type OwnerPolicyStore struct {
	client    ctrlclient.Client
	reader    ctrlclient.Reader
	namespace string
	name      string
	grants    *Service

	mu      sync.Mutex
	applied [sha256.Size]byte
	failed  [sha256.Size]byte
}

// NewOwnerPolicyStore returns a store for ConfigMap namespace/name.
func NewOwnerPolicyStore(client ctrlclient.Client, reader ctrlclient.Reader, namespace, name string, grants *Service) *OwnerPolicyStore {
	if reader == nil {
		reader = client
	}
	return &OwnerPolicyStore{client: client, reader: reader, namespace: namespace, name: name, grants: grants}
}

// ownerPolicyDoc is the policy JSON with its templates split out. Fields other
// than templates are kept byte for byte.
type ownerPolicyDoc struct {
	fields    map[string]json.RawMessage
	templates []json.RawMessage
	names     []string
}

// parseOwnerPolicyDoc decodes raw policy JSON.
func parseOwnerPolicyDoc(raw string) (*ownerPolicyDoc, error) {
	doc := &ownerPolicyDoc{fields: map[string]json.RawMessage{}}
	if strings.TrimSpace(raw) != "" {
		if err := json.Unmarshal([]byte(raw), &doc.fields); err != nil {
			return nil, opWrap(http.StatusInternalServerError, "owner_policy_invalid", "stored owner policy is not JSON", err)
		}
	}
	if t, ok := doc.fields["templates"]; ok {
		if err := json.Unmarshal(t, &doc.templates); err != nil {
			return nil, opWrap(http.StatusInternalServerError, "owner_policy_invalid", "stored owner policy templates are not a list", err)
		}
	}
	for _, t := range doc.templates {
		var head struct {
			Name string `json:"name"`
		}
		if err := json.Unmarshal(t, &head); err != nil {
			return nil, opWrap(http.StatusInternalServerError, "owner_policy_invalid", "stored owner policy template is not an object", err)
		}
		doc.names = append(doc.names, head.Name)
	}
	return doc, nil
}

// index returns the position of template name, or -1.
func (d *ownerPolicyDoc) index(name string) int {
	for i, n := range d.names {
		if n == name {
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
	d.fields["templates"] = t
	b, err := json.MarshalIndent(d.fields, "", "  ")
	if err != nil {
		return "", err
	}
	return string(b), nil
}

// Templates returns the templates of the stored policy.
func (p *OwnerPolicyStore) Templates(ctx context.Context) ([]TemplateRequest, error) {
	cm, err := p.get(ctx)
	if err != nil {
		return nil, err
	}
	var policy OwnerPolicy
	if raw := strings.TrimSpace(cm.Data[OwnerPolicyKey]); raw != "" {
		if err := json.Unmarshal([]byte(raw), &policy); err != nil {
			return nil, opWrap(http.StatusInternalServerError, "owner_policy_invalid", "stored owner policy is not JSON", err)
		}
	}
	if policy.Templates == nil {
		return []TemplateRequest{}, nil
	}
	return policy.Templates, nil
}

// PutTemplate adds tpl to the policy, or replaces the template of the same name.
func (p *OwnerPolicyStore) PutTemplate(ctx context.Context, tpl TemplateRequest) error {
	if tpl.Name == "" {
		return opErr(http.StatusBadRequest, "invalid_template", "template name is required")
	}
	if len(bytes.TrimSpace(tpl.Spec)) == 0 || string(bytes.TrimSpace(tpl.Spec)) == "null" {
		return opErr(http.StatusBadRequest, "invalid_template", "template spec is required")
	}
	entry, err := json.Marshal(tpl)
	if err != nil {
		return opWrap(http.StatusBadRequest, "invalid_template", "", err)
	}
	return p.mutate(ctx, func(d *ownerPolicyDoc) error {
		if i := d.index(tpl.Name); i >= 0 {
			d.templates[i] = entry
			return nil
		}
		d.templates = append(d.templates, entry)
		d.names = append(d.names, tpl.Name)
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
		d.names = append(d.names[:i], d.names[i+1:]...)
		return nil
	})
}

// mutate edits the stored policy, applies it, and writes it back. A concurrent
// write to the ConfigMap restarts the edit from the new content.
func (p *OwnerPolicyStore) mutate(ctx context.Context, edit func(*ownerPolicyDoc) error) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	return retry.RetryOnConflict(retry.DefaultRetry, func() error {
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
		raw, err := doc.encode()
		if err != nil {
			return opWrap(http.StatusInternalServerError, "owner_policy_invalid", "", err)
		}
		if err := p.apply(ctx, raw); err != nil {
			return err
		}
		if cm.Data == nil {
			cm.Data = map[string]string{}
		}
		cm.Data[OwnerPolicyKey] = raw
		if err := p.client.Update(ctx, cm); err != nil {
			return err
		}
		p.applied = sha256.Sum256([]byte(raw))
		return nil
	})
}

// apply decodes raw and sets it as the owner policy of the grant service.
func (p *OwnerPolicyStore) apply(ctx context.Context, raw string) error {
	var policy OwnerPolicy
	if err := json.Unmarshal([]byte(raw), &policy); err != nil {
		return opWrap(http.StatusBadRequest, "invalid_owner_policy", "owner policy is not JSON", err)
	}
	return p.grants.SetOwnerPolicy(ctx, policy)
}

// get reads the policy ConfigMap.
func (p *OwnerPolicyStore) get(ctx context.Context) (*corev1.ConfigMap, error) {
	cm := &corev1.ConfigMap{}
	if err := p.reader.Get(ctx, types.NamespacedName{Namespace: p.namespace, Name: p.name}, cm); err != nil {
		return nil, opWrap(http.StatusInternalServerError, "owner_policy_unavailable", p.name, err)
	}
	return cm, nil
}

// Sync applies the stored policy when it differs from the last one applied.
// A policy that fails is not retried until the ConfigMap changes again.
func (p *OwnerPolicyStore) Sync(ctx context.Context) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	cm, err := p.get(ctx)
	if err != nil {
		return err
	}
	raw := cm.Data[OwnerPolicyKey]
	sum := sha256.Sum256([]byte(raw))
	if sum == p.applied || sum == p.failed || strings.TrimSpace(raw) == "" {
		return nil
	}
	if err := p.apply(ctx, raw); err != nil {
		var op *OpError
		if errors.As(err, &op) && op.Status < http.StatusInternalServerError {
			p.failed = sum
		}
		return err
	}
	p.applied = sum
	return nil
}

// Run calls Sync every interval until ctx ends.
func (p *OwnerPolicyStore) Run(ctx context.Context, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		if err := p.Sync(ctx); err != nil {
			log.Warn("owner policy sync failed", "configmap", p.name, "error", err)
		} else {
			log.Debug("owner policy in sync", "configmap", p.name)
		}
	}
}
