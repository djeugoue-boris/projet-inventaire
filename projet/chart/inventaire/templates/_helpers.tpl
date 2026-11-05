{{/* Nom du chart */}}
{{- define "inventaire.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Nom complet : reprend le nom de la release (ex. "inventaire") */}}
{{- define "inventaire.fullname" -}}
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

{{/* Nom d'un composant : <fullname>-<composant> (ex. inventaire-api) */}}
{{- define "inventaire.componentName" -}}
{{- printf "%s-%s" (include "inventaire.fullname" .ctx) .component | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* Labels de selection (stables, utilises par les selectors) */}}
{{- define "inventaire.selectorLabels" -}}
app.kubernetes.io/name: {{ include "inventaire.name" .ctx }}
app.kubernetes.io/instance: {{ .ctx.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* Labels communs a toutes les ressources d'un composant */}}
{{- define "inventaire.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .ctx.Chart.Name .ctx.Chart.Version | replace "+" "_" }}
{{ include "inventaire.selectorLabels" . }}
app.kubernetes.io/version: {{ .ctx.Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .ctx.Release.Service }}
app.kubernetes.io/part-of: inventaire
{{- end -}}

{{/* Label "app" court, utilise par Fluent Bit / Loki pour filtrer les logs */}}
{{- define "inventaire.appLabel" -}}
app: {{ include "inventaire.componentName" . }}
{{- end -}}
