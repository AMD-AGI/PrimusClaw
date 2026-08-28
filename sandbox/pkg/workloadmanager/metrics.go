// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Package workloadmanager — Prometheus metrics for the Workload Manager.
package workloadmanager

import (
	"github.com/gin-gonic/gin"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	sandboxCreateTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "wm_sandbox_create_total",
			Help: "Total sandbox creation attempts",
		},
		[]string{"template", "status"},
	)

	sandboxDeleteTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "wm_sandbox_delete_total",
			Help: "Total sandbox deletions",
		},
		[]string{"reason"},
	)

	sandboxActiveGauge = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "wm_sandbox_active",
			Help: "Number of active sandboxes in Redis",
		},
	)

	templateTotal = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "wm_template_total",
			Help: "Total number of CodeInterpreter templates",
		},
	)

	policyUpdateTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "wm_policy_update_total",
			Help: "Total policy update requests",
		},
		[]string{"session_id"},
	)

	gcCycleTotal = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "wm_gc_cycle_total",
			Help: "Total GC cycles executed",
		},
	)
)

// wmMetricsHandler returns the Prometheus metrics HTTP handler for WM.
func wmMetricsHandler(refresh func()) gin.HandlerFunc {
	h := promhttp.Handler()
	return func(c *gin.Context) {
		if refresh != nil {
			refresh()
		}
		h.ServeHTTP(c.Writer, c.Request)
	}
}
