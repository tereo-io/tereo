#!/bin/sh
# Renders the chart with ci/provisioning-values.yaml and checks the
# provisioning resources. Run from the repository root.
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

helm template t "$chart" -f "$chart/ci/provisioning-values.yaml" \
  --set provisioning.existingConfigMap=x >"$out"
lacks "$out" 'kind: ConfigMap' 'ConfigMap rendered despite existingConfigMap'
has "$out" 'name: x' 'existingConfigMap not mounted'

helm template t "$chart" -f "$chart/ci/minimal-values.yaml" >"$out"
lacks "$out" 'PROVISIONING_PATH' 'PROVISIONING_PATH set without documents'
lacks "$out" 'provision' 'provisioning rendered without documents'
echo OK
