#!/bin/sh
# Renders the chart with ci/provisioning-values.yaml and checks the
# provisioning resources, then the optional Redis env vars. Run from the repository root.
set -eu

chart=charts/tereo
out=$(mktemp)
trap 'rm -f "$out"' EXIT
fail() { echo "FAIL: $1" >&2; exit 1; }
has() { grep -qF -- "$2" "$1" || fail "$3"; }
lacks() { ! grep -qF -- "$2" "$1" || fail "$3"; }

helm template t "$chart" -f "$chart/ci/provisioning-values.yaml" >"$out"
has "$out" 'alpha.json: "{' 'ConfigMap lacks alpha.json'
has "$out" 'beta.json: "{' 'ConfigMap lacks beta.json'
has "$out" 'value: /etc/tereo/provisioning' 'PROVISIONING_PATH not set'
has "$out" 'mountPath: /etc/tereo/provisioning' 'documents not mounted as a directory'
lacks "$out" 'checksum/provisioning' 'pods must not roll on provisioning changes'
has "$out" 'helm.sh/hook: post-install,post-upgrade' 'provision Job missing'
has "$out" '"dist/cli/index.js", "provision"' 'Job does not run provision'

lacks "$out" 'memory: 321Mi' 'provision Job resources rendered while unset'
helm template t "$chart" -f "$chart/ci/provisioning-values.yaml" \
  --set provisioning.job.resources.limits.memory=321Mi \
  --show-only templates/provision-job.yaml >"$out"
has "$out" 'memory: 321Mi' 'provisioning.job.resources not rendered'

helm template t "$chart" -f "$chart/ci/provisioning-values.yaml" \
  --set provisioning.existingConfigMap=x >"$out"
lacks "$out" 'kind: ConfigMap' 'ConfigMap rendered despite existingConfigMap'
has "$out" 'name: x' 'existingConfigMap not mounted'

helm template t "$chart" -f "$chart/ci/provisioning-values.yaml" \
  --set provisioning.job.enabled=false >"$out"
lacks "$out" '"dist/cli/index.js", "provision"' 'provision Job rendered with provisioning.job.enabled=false'
has "$out" 'alpha.json: "{' 'ConfigMap dropped with the Job disabled'
has "$out" 'value: /etc/tereo/provisioning' 'PROVISIONING_PATH dropped with the Job disabled'

helm template t "$chart" -f "$chart/ci/provisioning-values.yaml" \
  --set-string 'provisioning.job.annotations.argocd\.argoproj\.io/hook=Sync' \
  --set-string 'provisioning.job.annotations.helm\.sh/hook-weight=5' \
  --show-only templates/provision-job.yaml >"$out"
has "$out" 'argocd.argoproj.io/hook: Sync' 'provisioning.job.annotations not rendered'
has "$out" 'helm.sh/hook-weight: "5"' 'provisioning.job.annotations do not override the hook annotations'
lacks "$out" 'helm.sh/hook-weight: "0"' 'hook annotation duplicated'
has "$out" 'helm.sh/hook: post-install,post-upgrade' 'hook annotations dropped with annotations set'

helm template t "$chart" -f "$chart/ci/minimal-values.yaml" >"$out"
lacks "$out" 'PROVISIONING_PATH' 'PROVISIONING_PATH set without documents'
lacks "$out" 'provision' 'provisioning rendered without documents'
helm template t "$chart" -f "$chart/ci/minimal-values.yaml" --set redis.db=null >"$out"
lacks "$out" 'REDIS_DB' 'REDIS_DB rendered with redis.db=null'
lacks "$out" '<nil>' 'a null value rendered as <nil>'
helm template t "$chart" -f "$chart/ci/minimal-values.yaml" --set redis.db=0 >"$out"
has "$out" 'name: REDIS_DB' 'REDIS_DB dropped with redis.db=0'
has "$out" 'value: "0"' 'REDIS_DB=0 not rendered'
helm template t "$chart" -f "$chart/ci/minimal-values.yaml" >"$out"
lacks "$out" 'REDIS_DB' 'REDIS_DB rendered while unset'
helm template t "$chart" -f "$chart/ci/minimal-values.yaml" --set redis.keyPrefix=null >"$out"
lacks "$out" 'REDIS_KEY_PREFIX' 'REDIS_KEY_PREFIX rendered with redis.keyPrefix=null'
echo OK
