// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Package router — Prometheus metrics for the API Gateway.
package router

import (
	"strconv"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/prometheus/client_golang/prometheus/promhttp"
)

var (
	requestsTotal = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "router_requests_total",
			Help: "Total number of requests handled by the Router",
		},
		[]string{"method", "path", "status_code"},
	)

	requestDuration = promauto.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:    "router_request_duration_seconds",
			Help:    "Request duration in seconds",
			Buckets: prometheus.DefBuckets,
		},
		[]string{"method", "path"},
	)

	activeSessions = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "router_active_sessions",
			Help: "Number of active sandbox sessions in the store",
		},
	)

	portProxyRequests = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "router_port_proxy_requests_total",
			Help: "Total number of port proxy requests",
		},
		[]string{"port", "status_code"},
	)

	// Split by which credential was rejected, because the two mean opposite
	// things and are indistinguishable from the status code alone.
	//
	// stage="caller" is the caller's own SaFE credential: their problem, and
	// the expected steady-state noise from expired cookies. stage="envd" is
	// the Router's own JWT being refused by the sandbox, which no caller can
	// cause or fix -- the Router overwrites Authorization before proxying, so
	// the caller's credential never reaches EnvD. That one means Router and
	// EnvD disagree about the signing key, i.e. every exec in the cluster is
	// failing, and it is the signal worth alerting on.
	sandboxAuthRejections = promauto.NewCounterVec(
		prometheus.CounterOpts{
			Name: "router_sandbox_auth_rejections_total",
			Help: "Authentication rejections by which credential was refused: stage=caller on any authenticated route, stage=envd on the sandbox exec path.",
		},
		[]string{"stage", "status_code"},
	)
)

// Response header naming the authentication layer that produced a 401/403, so
// triage does not have to pattern-match on error prose that is free to change.
const authStageHeader = "X-Sandbox-Auth-Stage"

const (
	authStageCaller = "caller"
	authStageEnvD   = "envd"
)

// recordCallerAuthRejection tags a rejection of the caller's own credential.
func recordCallerAuthRejection(c *gin.Context, status int) {
	c.Header(authStageHeader, authStageCaller)
	sandboxAuthRejections.WithLabelValues(authStageCaller, strconv.Itoa(status)).Inc()
}

// metricsMiddleware records request count and duration for all routes.
func metricsMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		start := time.Now()
		c.Next()
		duration := time.Since(start).Seconds()

		path := c.FullPath()
		if path == "" {
			path = "unknown"
		}
		status := strconv.Itoa(c.Writer.Status())

		requestsTotal.WithLabelValues(c.Request.Method, path, status).Inc()
		requestDuration.WithLabelValues(c.Request.Method, path).Observe(duration)
	}
}

// metricsHandler returns the Prometheus metrics HTTP handler.
func metricsHandler(refresh func()) gin.HandlerFunc {
	h := promhttp.Handler()
	return func(c *gin.Context) {
		if refresh != nil {
			refresh()
		}
		h.ServeHTTP(c.Writer, c.Request)
	}
}
