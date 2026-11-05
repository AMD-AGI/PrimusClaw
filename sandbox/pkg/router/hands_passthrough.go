// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package router

import (
	"github.com/gin-gonic/gin"
)

const (
	// HandsTokenHeader carries the per-sandbox Hands token, which Hands validates.
	HandsTokenHeader = "X-Hands-Token"

	ctxHandsPassthrough = "handsPassthrough"
)

// handsPort is the sandbox port that serves Hands. Overridden in tests.
var handsPort = 9100

// isHandsPassthrough reports whether the request is a port proxy call to the Hands
// port that carries a Hands token. Such a call needs no platform credential.
func isHandsPassthrough(c *gin.Context) bool {
	if c.FullPath() != invocationRoute || c.GetHeader(HandsTokenHeader) == "" {
		return false
	}
	port, _, err := parsePortProxyPath(c.Param("path"))
	return err == nil && port == handsPort
}

// handsPassthroughFrom reports whether caller authentication let this request through as a Hands call.
func handsPassthroughFrom(c *gin.Context) bool {
	return c.GetBool(ctxHandsPassthrough)
}
