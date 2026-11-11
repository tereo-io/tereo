#!/bin/sh
# Renders the chart with and without networkPolicy and checks the
# NetworkPolicy. Run from the repository root.
set -eu

chart=charts/tereo
out=$(mktemp)
trap 'rm -f "$out"' EXIT
fail() { echo "FAIL: $1" >&2; exit 1; }
has() { grep -qF -- "$2" "$1" || fail "$3"; }
lacks() { ! grep -qF -- "$2" "$1" || fail "$3"; }

helm template t "$chart" -f "$chart/ci/minimal-values.yaml" >"$out"
lacks "$out" 'kind: NetworkPolicy' 'NetworkPolicy rendered while disabled'

helm template t "$chart" -f "$chart/ci/networkpolicy-values.yaml" \
  --show-only templates/networkpolicy.yaml >"$out"
has "$out" 'kind: NetworkPolicy' 'NetworkPolicy not rendered'
has "$out" 'app.kubernetes.io/component: api' 'policy does not select the API pods'
lacks "$out" 'app.kubernetes.io/component: worker' 'policy selects the worker pods'
has "$out" '- Ingress' 'policy is not an ingress policy'
lacks "$out" '- Egress' 'policy restricts egress'
has "$out" 'kubernetes.io/metadata.name: ingress-nginx' 'ingress controller peer not rendered'
has "$out" 'app.kubernetes.io/name: billing' 'app service peer not rendered'
has "$out" 'port: http' 'policy does not name the HTTP port'

if helm template t "$chart" -f "$chart/ci/minimal-values.yaml" \
  --set networkPolicy.enabled=true >"$out" 2>&1; then
  fail 'rendered with networkPolicy.enabled and no ingressFrom, which would cut core off'
fi
has "$out" 'networkPolicy.ingressFrom' 'the refusal does not name networkPolicy.ingressFrom'
echo OK
