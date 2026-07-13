{{/*
Expand the name of the chart.
*/}}
{{- define "acornops-agent.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Create a default fully qualified app name.
*/}}
{{- define "acornops-agent.fullname" -}}
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

{{- define "acornops-agent.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "acornops-agent.labels" -}}
helm.sh/chart: {{ include "acornops-agent.chart" . }}
{{ include "acornops-agent.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "acornops-agent.selectorLabels" -}}
app.kubernetes.io/name: {{ include "acornops-agent.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "acornops-agent.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "acornops-agent.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "acornops-agent.secretName" -}}
{{- if .Values.existingSecret.name -}}
{{- .Values.existingSecret.name -}}
{{- else -}}
{{- include "acornops-agent.fullname" . -}}
{{- end -}}
{{- end -}}

{{- define "acornops-agent.secretKey" -}}
{{- default "agent-key" .Values.existingSecret.key -}}
{{- end -}}

{{- define "acornops-agent.image" -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end -}}

{{- define "acornops-agent.websocketUrl" -}}
{{- if .Values.config.websocketUrl -}}
{{- if hasPrefix "ws://" .Values.config.websocketUrl -}}
{{- fail "config.websocketUrl must use wss://; ws:// is not allowed" -}}
{{- end -}}
{{- if not (hasPrefix "wss://" .Values.config.websocketUrl) -}}
{{- fail "config.websocketUrl must start with wss://" -}}
{{- end -}}
{{- .Values.config.websocketUrl -}}
{{- else -}}
{{- $platformUrl := required "config.platformUrl or config.websocketUrl is required" .Values.config.platformUrl | trimSuffix "/" -}}
{{- if hasPrefix "https://" $platformUrl -}}
{{- printf "%s/api/v1/agent/connect" (replace "https://" "wss://" $platformUrl) -}}
{{- else if hasPrefix "http://" $platformUrl -}}
{{- fail "config.platformUrl must use https://; http:// is not allowed" -}}
{{- else -}}
{{- fail "config.platformUrl must start with https:// when config.websocketUrl is not set" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* Validate and report whether an additional platform CA bundle is configured. */}}
{{- define "acornops-agent.platformAdditionalCaEnabled" -}}
{{- $bundle := .Values.config.tls.additionalCaBundle -}}
{{- $configMapRef := $bundle.configMapKeyRef -}}
{{- $secretKeyRef := $bundle.secretKeyRef -}}
{{- $hasConfigMapRef := kindIs "map" $configMapRef -}}
{{- $hasSecretKeyRef := kindIs "map" $secretKeyRef -}}
{{- if and $hasConfigMapRef $hasSecretKeyRef -}}
{{- fail "config.tls.additionalCaBundle must configure only one of configMapKeyRef or secretKeyRef" -}}
{{- end -}}
{{- if $hasConfigMapRef -}}
{{- $_ := required "config.tls.additionalCaBundle.configMapKeyRef.name is required when configMapKeyRef is configured" $configMapRef.name -}}
{{- $_ := required "config.tls.additionalCaBundle.configMapKeyRef.key is required when configMapKeyRef is configured" $configMapRef.key -}}
true
{{- else if $hasSecretKeyRef -}}
{{- $_ := required "config.tls.additionalCaBundle.secretKeyRef.name is required when secretKeyRef is configured" $secretKeyRef.name -}}
{{- $_ := required "config.tls.additionalCaBundle.secretKeyRef.key is required when secretKeyRef is configured" $secretKeyRef.key -}}
true
{{- end -}}
{{- end -}}

{{/* Fixed file path consumed by Node.js for additional platform CA trust. */}}
{{- define "acornops-agent.platformAdditionalCaPath" -}}
/etc/acornops/trust/platform-ca.pem
{{- end -}}

{{- define "acornops-agent.rbacNamespaces" -}}
{{- $namespaces := .Values.rbac.namespaces | default list -}}
{{- if $namespaces -}}
{{- toYaml $namespaces -}}
{{- else if .Values.namespaceScope.include -}}
{{- toYaml .Values.namespaceScope.include -}}
{{- else -}}
{{- list .Release.Namespace | toYaml -}}
{{- end -}}
{{- end -}}

{{- define "acornops-agent.leaseNamespace" -}}
{{- default .Release.Namespace .Values.leaderElection.leaseNamespace -}}
{{- end -}}

{{- define "acornops-agent.leaderElectionName" -}}
{{- printf "%s-leader-election" (include "acornops-agent.fullname" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
