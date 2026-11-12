// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

package main

import (
	"os"
	"strings"

	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"

	"sigs.k8s.io/agent-sandbox/pkg/authz"
	"sigs.k8s.io/agent-sandbox/pkg/grant"
	"sigs.k8s.io/agent-sandbox/pkg/identity"
	log "sigs.k8s.io/agent-sandbox/pkg/logx"
	"sigs.k8s.io/agent-sandbox/pkg/router"
	"sigs.k8s.io/agent-sandbox/pkg/usercr"
	"sigs.k8s.io/agent-sandbox/pkg/workloadmanager"
)

// wireWorkspaceAuth selects the workspace authorizer and installs it on the Router and the Workload Manager.
// Workspace SAR reviews the identity subject. Otherwise the SaFE User lists the workspaces.
// The bool is true only for workspace SAR, which rechecks a grant owner on create.
func wireWorkspaceAuth(clientset kubernetes.Interface, dyn dynamic.Interface, routerCfg *router.Config, wmCfg *workloadmanager.Config) (grant.Authorizer, bool) {
	if authz.WorkspaceSARFromEnv() {
		az, err := authz.FromClientset(clientset)
		if err != nil {
			log.Error("workspace SAR config is invalid", "error", err)
			os.Exit(1)
		}
		routerCfg.Authz = az
		wmCfg.Authz = az
		log.Info("workspace SAR enabled", "subjectPrefix", authz.PrefixFromEnv())
		return az, true
	}
	users := usercr.New(dyn)
	routerCfg.Authz = users
	wmCfg.Authz = users
	log.Info("workspace SAR disabled; membership comes from the SaFE User")
	return users, false
}

// wireWorkloadAssertion turns Workload assertion on when ENABLE_WORKLOAD_ASSERTION is true.
// That switch exits when the token endpoint is missing. With the switch off, a missing token URL is only a warning.
func wireWorkloadAssertion(workloads *workloadmanager.SafeWorkloadCreator, attester *identity.Attester) {
	if os.Getenv("ENABLE_WORKLOAD_ASSERTION") == "true" {
		if attester == nil {
			log.Error("ENABLE_WORKLOAD_ASSERTION=true requires IDENTITY_TOKEN_URL, IDENTITY_CLIENT_ID and IDENTITY_CLIENT_SECRET")
			os.Exit(1)
		}
		workloads.SetAttestWorkloads(true)
		workloads.SetIdentityAttester(attester)
		log.Info("workload assertion enabled")
		return
	}
	if attester != nil {
		workloads.SetIdentityAttester(attester)
	}
	if strings.TrimSpace(os.Getenv("IDENTITY_TOKEN_URL")) == "" {
		log.Warn("IDENTITY_TOKEN_URL is unset; workload assertion stays off until ENABLE_WORKLOAD_ASSERTION=true")
	}
}
