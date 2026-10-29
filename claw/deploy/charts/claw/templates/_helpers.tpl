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

{{- /*
One optional identity setting as an env entry, rendered only when it has a value.

Not `default`, `with` or `empty`: all three read a numeric 0 as absent, and 0 is a
real value for the cache and stale windows (it switches them off). `kindIs
"invalid"` is the nil half; `toString nil` is "<nil>", so nil is tested apart.

Call as: include "primus-claw.identityOptionalEnv" (dict "name" "IDENTITY_JWKS_URL" "value" .Values.identity.jwksUrl)
*/ -}}
{{- define "primus-claw.identityOptionalEnv" -}}
{{- if and (not (kindIs "invalid" .value)) (ne (toString .value) "") }}
- name: {{ .name }}
  value: {{ .value | toString | quote }}
{{- end }}
{{- end -}}

{{- /*
The identity client's environment for one container. Renders nothing while
identity.enabled is false, so the default chart is byte-for-byte what it was.
Shared by the API and Brain Deployments: the same switch, the same issuer, the
same client, so they cannot be configured to disagree.
*/ -}}
{{- define "primus-claw.identityEnv" -}}
{{- $i := .Values.identity | default dict -}}
{{- if $i.enabled -}}
- name: IDENTITY_CLIENT_ENABLED
  value: "true"
- name: IDENTITY_ISSUER_URL
  value: {{ required "identity.issuerUrl is required when identity.enabled is true" $i.issuerUrl | quote }}
- name: IDENTITY_CLIENT_ID
  value: {{ required "identity.clientId is required when identity.enabled is true" $i.clientId | quote }}
- name: IDENTITY_CLIENT_SECRET
  valueFrom:
    secretKeyRef:
      name: {{ required "identity.clientSecret.existingSecret is required when identity.enabled is true" (dig "clientSecret" "existingSecret" "" $i) | quote }}
      key: {{ dig "clientSecret" "key" "client-secret" $i | quote }}
{{- include "primus-claw.identityOptionalEnv" (dict "name" "IDENTITY_DISCOVERY_URL" "value" $i.discoveryUrl) }}
{{- include "primus-claw.identityOptionalEnv" (dict "name" "IDENTITY_INTROSPECTION_URL" "value" (dig "endpoints" "introspection" "" $i)) }}
{{- include "primus-claw.identityOptionalEnv" (dict "name" "IDENTITY_TOKEN_URL" "value" (dig "endpoints" "token" "" $i)) }}
{{- include "primus-claw.identityOptionalEnv" (dict "name" "IDENTITY_JWKS_URL" "value" (dig "endpoints" "jwks" "" $i)) }}
{{- include "primus-claw.identityOptionalEnv" (dict "name" "IDENTITY_INTROSPECTION_CACHE_SECONDS" "value" (dig "cache" "positiveSeconds" "" $i)) }}
{{- include "primus-claw.identityOptionalEnv" (dict "name" "IDENTITY_INTROSPECTION_NEGATIVE_CACHE_SECONDS" "value" (dig "cache" "negativeSeconds" "" $i)) }}
{{- include "primus-claw.identityOptionalEnv" (dict "name" "IDENTITY_STALE_IF_ERROR_SECONDS" "value" (dig "cache" "staleIfErrorSeconds" "" $i)) }}
{{- include "primus-claw.identityOptionalEnv" (dict "name" "IDENTITY_REQUEST_TIMEOUT_MS" "value" $i.requestTimeoutMs) }}
{{- include "primus-claw.identityOptionalEnv" (dict "name" "IDENTITY_KEYS_REFRESH_SECONDS" "value" $i.keysRefreshSeconds) }}
{{- include "primus-claw.identityOptionalEnv" (dict "name" "IDENTITY_EXCHANGE_REFRESH_SKEW_SECONDS" "value" $i.exchangeRefreshSkewSeconds) }}
{{- end }}
{{- end -}}

{{- /*
Accepting an identity provider's access token as an API credential, for the API
Deployment only (Brain authenticates nobody with it). Renders nothing while
identity.tokenAuth.enabled is false, so the default chart is byte-for-byte what it
was. The token is verified by the identity client, so it also needs identity.enabled:
asking for one without the other is refused here rather than rendered as a switch
that quietly does nothing. identity.tokenAuth.trustedRoles (empty by default) names the
platform roles a token the provider confirms may confer; it renders only when it is not empty.
*/ -}}
{{- define "primus-claw.identityTokenEnv" -}}
{{- $i := .Values.identity | default dict -}}
{{- $t := $i.tokenAuth | default dict -}}
{{- if $t.enabled -}}
{{- if not $i.enabled -}}
{{- fail "identity.tokenAuth.enabled requires identity.enabled: the access token is verified by the identity client" -}}
{{- end -}}
- name: CLAW_IDENTITY_TOKEN_AUTH_ENABLED
  value: "true"
{{- include "primus-claw.identityOptionalEnv" (dict "name" "CLAW_IDENTITY_TOKEN_AUDIENCE" "value" $t.audience) }}
{{- include "primus-claw.identityOptionalEnv" (dict "name" "CLAW_IDENTITY_TOKEN_SCOPE" "value" $t.scope) }}
{{- if $t.introspect }}
- name: CLAW_IDENTITY_TOKEN_INTROSPECT
  value: "true"
{{- end }}
{{- with $t.trustedRoles }}
- name: CLAW_IDENTITY_TOKEN_TRUSTED_ROLES
  value: {{ join "," . | quote }}
{{- end }}
{{- end }}
{{- end -}}

{{- /*
The externally reachable base URL of the API (CLAW_PUBLIC_URL), or the empty
string when nothing says what it is.

api.publicUrl wins when set. Otherwise, with the ingress enabled, it is
https://<ingress.host><ingress.path>: the ingress serves the API under that
path and rewrites it away, so the API cannot see the prefix a client has to use
and A2A agent cards would advertise <host>/a2a instead of <host><path>/a2a.
Without an ingress host there is nothing to derive from, and the API falls back
to the proxy's forwarded headers, then to a relative URL.
*/ -}}
{{- define "primus-claw.publicUrl" -}}
{{- if .Values.api.publicUrl -}}
{{- .Values.api.publicUrl | trimSuffix "/" -}}
{{- else if and .Values.ingress.enabled .Values.ingress.host -}}
{{- printf "https://%s%s" .Values.ingress.host (.Values.ingress.path | default "" | trimSuffix "/") -}}
{{- end -}}
{{- end -}}
