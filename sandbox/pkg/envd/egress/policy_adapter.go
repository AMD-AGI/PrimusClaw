// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package egress

import (
	"context"

	"sigs.k8s.io/agent-sandbox/pkg/policy"
)

// PolicyEngineAdapter adapts policy.Engine to the egress.PolicyEvaluator interface.
type PolicyEngineAdapter struct {
	engine *policy.Engine
}

// NewPolicyEngineAdapter wraps a policy Engine as a PolicyEvaluator.
func NewPolicyEngineAdapter(engine *policy.Engine) PolicyEvaluator {
	return &PolicyEngineAdapter{engine: engine}
}

// Evaluate converts egress.EgressRequest to policy.EgressRequest and delegates.
func (a *PolicyEngineAdapter) Evaluate(ctx context.Context, req EgressRequest) Decision {
	pReq := policy.EgressRequest{
		OriginalIP:   req.OriginalIP.String(),
		OriginalPort: req.OriginalPort,
		Domain:       req.Domain,
		IsTLS:        req.IsTLS,
	}
	if req.ResolvedIP != nil {
		pReq.ResolvedIP = req.ResolvedIP.String()
	}

	d := a.engine.Evaluate(ctx, pReq)

	return Decision{
		Action: d.Action,
		Reason: d.Reason,
	}
}
