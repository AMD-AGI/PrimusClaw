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

{{- /*
One workload's NATS credential Secret, or the empty string when that workload
has no password configured.

Factored out of nats-user-secrets.yaml so a Deployment can hash exactly its own
credential (checksum/nats-user) rather than the file holding all four. Rotating
api's password must not restart brain.

Call as: include "primus-claw.natsUserSecret" (dict "root" . "component" "api")
*/ -}}
{{- define "primus-claw.natsUserSecret" -}}
{{- $root := .root -}}
{{- $component := .component -}}
{{- $creds := get $root.Values.secret.natsUsers $component -}}
{{- if and $creds $creds.password -}}
apiVersion: v1
kind: Secret
metadata:
  name: {{ printf "primus-claw-nats-%s" $component }}
  labels:
    {{- include "primus-claw.labels" $root | nindent 4 }}
    component: {{ printf "primus-claw-%s" $component }}
type: Opaque
stringData:
  NATS_USER: {{ default $component $creds.user | quote }}
  NATS_PASSWORD: {{ $creds.password | quote }}
{{- end -}}
{{- end -}}
