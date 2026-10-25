// SPDX-FileCopyrightText: Advanced Micro Devices, Inc.
// SPDX-License-Identifier: Apache-2.0

// Package store provides session→sandbox state storage abstractions.
// Production control plane uses a CR-backed Store in package workloadmanager;
// MemoryStore is for tests and local-dev without Kubernetes.
package store
