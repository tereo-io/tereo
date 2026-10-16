{{- define "tereo.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "tereo.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "tereo.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "tereo.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- /* Takes (dict "root" $ "component" "api"). */ -}}
{{- define "tereo.selectorLabels" -}}
app.kubernetes.io/name: {{ include "tereo.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end }}

{{- define "tereo.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) }}
{{- end }}

{{- define "tereo.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "tereo.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- /* The Secret core reads DATABASE_URL, CORE_KEK and Redis from. */ -}}
{{- define "tereo.secretName" -}}
{{- if .Values.secrets.externalSecret.enabled }}
{{- include "tereo.fullname" . }}
{{- else }}
{{- .Values.secrets.existingSecret }}
{{- end }}
{{- end }}

{{- define "tereo.claimName" -}}
{{- default (printf "%s-storage" (include "tereo.fullname" .)) .Values.persistence.existingClaim }}
{{- end }}

{{- /* publicUrl's scheme://host[:port], without a path. */ -}}
{{- define "tereo.publicOrigin" -}}
{{- $u := urlParse .Values.publicUrl }}
{{- printf "%s://%s" $u.scheme $u.host }}
{{- end }}

{{- define "tereo.ingressHost" -}}
{{- default (regexReplaceAll ":[0-9]+$" (urlParse .Values.publicUrl).host "") .Values.ingress.host }}
{{- end }}

{{- /*
Refuses a configuration core would refuse at start, or one that would lose
files: blobs live on the volume, so every core pod must share it.
*/ -}}
{{- define "tereo.validate" -}}
{{- if not .Values.publicUrl }}
{{- fail "publicUrl is required: core's externally reachable https:// URL" }}
{{- end }}
{{- if not (hasPrefix "https://" .Values.publicUrl) }}
{{- fail "publicUrl must be an https:// URL; core refuses anything else in production" }}
{{- end }}
{{- if eq (toString .Values.trustProxy) "" }}
{{- fail "trustProxy is required: \"1\" behind a single ingress, a CIDR list, or \"false\" with no proxy" }}
{{- end }}
{{- if eq (toString .Values.trustProxy) "true" }}
{{- fail "trustProxy \"true\" is refused by core: it would trust any client's X-Forwarded-For" }}
{{- end }}
{{- if not (regexMatch "^[0-9]+$" (toString .Values.preStopSleepSeconds)) }}
{{- fail "preStopSleepSeconds must be a whole number of seconds, 0 or more" }}
{{- end }}
{{- if and (not .Values.secrets.externalSecret.enabled) (not .Values.secrets.existingSecret) }}
{{- fail "set secrets.existingSecret, or enable secrets.externalSecret, for DATABASE_URL, CORE_KEK and Redis" }}
{{- end }}
{{- if and .Values.secrets.externalSecret.enabled (not .Values.secrets.externalSecret.secretStoreRef.name) }}
{{- fail "secrets.externalSecret.secretStoreRef.name is required when secrets.externalSecret.enabled" }}
{{- end }}
{{- if ne (empty .Values.redis.sentinels) (empty .Values.redis.masterName) }}
{{- fail "set both redis.sentinels and redis.masterName for Sentinel, or neither" }}
{{- end }}
{{- $pods := add (int .Values.replicaCount) (ternary (int .Values.worker.replicaCount) 0 .Values.worker.enabled) }}
{{- if gt (int $pods) 1 }}
{{- if not .Values.persistence.enabled }}
{{- fail "more than one core pod (replicaCount above 1, or worker.enabled) needs persistence: core keeps files on the volume, which every pod must share" }}
{{- end }}
{{- if and (not .Values.persistence.existingClaim) (not (has "ReadWriteMany" .Values.persistence.accessModes)) }}
{{- fail "more than one core pod (replicaCount above 1, or worker.enabled) needs persistence.accessModes to include ReadWriteMany: core keeps files on the volume" }}
{{- end }}
{{- end }}
{{- end }}

{{- /* Core's configuration, shared by its pods and the migration Job. */ -}}
{{- define "tereo.env" -}}
- name: PUBLIC_URL
  value: {{ .Values.publicUrl | quote }}
- name: CORS_ALLOWED_ORIGINS
  value: {{ default (list (include "tereo.publicOrigin" .)) .Values.corsAllowedOrigins | join "," | quote }}
- name: TRUST_PROXY
  value: {{ .Values.trustProxy | toString | quote }}
{{- with .Values.uiBaseUrl }}
- name: UI_BASE_URL
  value: {{ . | quote }}
{{- end }}
{{- if .Values.redis.sentinels }}
- name: REDIS_SENTINELS
  value: {{ .Values.redis.sentinels | quote }}
- name: REDIS_MASTER_NAME
  value: {{ .Values.redis.masterName | quote }}
{{- end }}
{{- with .Values.otelExporterEndpoint }}
- name: OTEL_EXPORTER_OTLP_ENDPOINT
  value: {{ . | quote }}
{{- end }}
- name: LOG_LEVEL
  value: {{ .Values.logLevel | quote }}
{{- range $name, $value := .Values.env }}
- name: {{ $name }}
  value: {{ $value | toString | quote }}
{{- end }}
{{- end }}

{{- define "tereo.envFrom" -}}
- secretRef:
    name: {{ include "tereo.secretName" . }}
{{- with .Values.extraEnvFrom }}
{{ toYaml . }}
{{- end }}
{{- end }}

{{/* Non-empty when core has provisioning documents to read. */}}
{{- define "tereo.provisioning" -}}
{{- if or .Values.provisioning.documents .Values.provisioning.existingConfigMap -}}true{{- end -}}
{{- end }}

{{/* The ConfigMap holding the documents: the existing one, or the chart's own. */}}
{{- define "tereo.provisioningConfigMap" -}}
{{- default (printf "%s-provisioning" (include "tereo.fullname" .)) .Values.provisioning.existingConfigMap -}}
{{- end }}
