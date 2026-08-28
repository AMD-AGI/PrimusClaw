{{/* Copyright Advanced Micro Devices, Inc. */}}
{{/* SPDX-License-Identifier: MIT */}}

{{- define "primus-claw.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "primus-claw.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- include "primus-claw.name" . -}}
{{- end -}}
{{- end -}}

{{- define "primus-claw.image" -}}
{{- printf "%s/%s:%s" .Values.image.registry .Values.image.repository .Values.image.tag -}}
{{- end -}}

{{- define "primus-claw.postgresUserSecretName" -}}
{{- default (printf "%s-pguser-%s" .Values.postgres.clusterName .Values.postgres.appUser) .Values.postgres.userSecretName -}}
{{- end -}}

{{- define "primus-claw.labels" -}}
app: primus-claw
app.kubernetes.io/name: {{ include "primus-claw.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}
