{{/* Copyright Advanced Micro Devices, Inc. */}}
{{/* SPDX-License-Identifier: MIT */}}

{{- define "claw-memory-service.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "claw-memory-service.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "claw-memory-service.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "claw-memory-service.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "claw-memory-service.selectorLabels" -}}
app.kubernetes.io/name: {{ include "claw-memory-service.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "claw-memory-service.namespace" -}}
{{- default .Release.Namespace .Values.namespaceOverride -}}
{{- end -}}

{{- define "claw-memory-service.postgresName" -}}
{{- printf "%s-postgres" (include "claw-memory-service.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- /*
Renders "true" only when the bundled Postgres backs the service. An external
database always wins, so every bundled resource and every bundled credential
requirement is keyed off this single decision.
*/ -}}
{{- define "claw-memory-service.useBundledPostgres" -}}
{{- if and .Values.postgres.enabled (not .Values.externalDatabase.url) (not .Values.externalDatabase.existingSecret) -}}
true
{{- end -}}
{{- end -}}
