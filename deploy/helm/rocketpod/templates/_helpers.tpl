{{/* Names and labels (M7). */}}
{{- define "rocketpod.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "rocketpod.fullname" -}}
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

{{- define "rocketpod.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "rocketpod.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{/* Selector labels for one component: web | worker | migrate. */}}
{{- define "rocketpod.selectorLabels" -}}
app.kubernetes.io/name: {{ include "rocketpod.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{- define "rocketpod.image" -}}
{{ .Values.image.repository }}:{{ .Values.image.tag | default .Chart.AppVersion }}
{{- end -}}

{{- define "rocketpod.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "rocketpod.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "rocketpod.secretName" -}}
{{- default (include "rocketpod.fullname" .) .Values.existingSecret -}}
{{- end -}}

{{/* envFrom for every app container: the ConfigMap, then the Secret. */}}
{{- define "rocketpod.envFrom" -}}
- configMapRef:
    name: {{ include "rocketpod.fullname" . }}
- secretRef:
    name: {{ include "rocketpod.secretName" . }}
{{- end -}}

{{- define "rocketpod.extraEnv" -}}
{{- with .Values.extraEnv }}
env:
{{- toYaml . | nindent 2 }}
{{- end }}
{{- end -}}

{{/* The pieces every app pod shares: security, /tmp, service account, pull secrets. */}}
{{- define "rocketpod.podCommon" -}}
serviceAccountName: {{ include "rocketpod.serviceAccountName" . }}
{{- with .Values.imagePullSecrets }}
imagePullSecrets:
{{- toYaml . | nindent 2 }}
{{- end }}
securityContext:
{{- toYaml .Values.podSecurityContext | nindent 2 }}
volumes:
  - name: tmp
    emptyDir: {}
{{- end -}}
