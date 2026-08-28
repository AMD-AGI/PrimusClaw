// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package egress

// DecisionEvent is a structured outbound access decision emitted by the proxy.
type DecisionEvent struct {
	Action     string
	Reason     string
	Stage      string
	Domain     string
	OriginalIP string
	ResolvedIP string
	Port       int
	IsTLS      bool
}

// EventReporter handles proxy decision events asynchronously.
type EventReporter interface {
	ReportDecision(event DecisionEvent)
}

// WithEventReporter attaches an optional decision reporter.
func (p *TransparentProxy) WithEventReporter(reporter EventReporter) *TransparentProxy {
	p.reporter = reporter
	return p
}

func (p *TransparentProxy) reportDecision(event DecisionEvent) {
	if p.reporter == nil {
		return
	}
	p.reporter.ReportDecision(event)
}
