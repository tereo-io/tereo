# Tereo Helm chart

Deploys [Tereo](https://github.com/tereo-io/tereo) core: its API, admin UI and background workers,
from `ghcr.io/tereo-io/tereo`. Each install is one app's core. Postgres and Redis are yours: the
chart reads their URLs from a Secret and deploys neither.

The chart is released with the image, at the same version:

```sh
helm install core oci://ghcr.io/tereo-io/charts/tereo --version 0.1.1 -f values.yaml
```

## Before installing

Create the Secret core reads. Every key becomes an environment variable:

| Key | |
|-----|-|
| `DATABASE_URL` | Postgres connection string |
| `CORE_KEK` | `openssl rand -base64 32`. Encrypts the keys core stores; without it they cannot be read, so keep a copy outside the cluster |
| `REDIS_URL` | Redis, e.g. `redis://:password@redis:6379` |
| `REDIS_PASSWORD` | Instead of `REDIS_URL`, with `redis.sentinels` and `redis.masterName` set |

```sh
kubectl create secret generic tereo-secrets \
  --from-literal=DATABASE_URL='postgresql://…' \
  --from-literal=REDIS_URL='redis://…' \
  --from-literal=CORE_KEK="$(openssl rand -base64 32)"
```

Or set `secrets.externalSecret` to have [External Secrets Operator](https://external-secrets.io)
build it from your store.

## Values

The ones every install sets:

```yaml
publicUrl: https://core.example.com   # core's https:// URL
trustProxy: "1"                        # the proxies in front of core
secrets:
  existingSecret: tereo-secrets
ingress:
  enabled: true
  className: nginx
  tls:
    - secretName: core-tls
      hosts: [core.example.com]
```

[values.yaml](https://github.com/tereo-io/tereo/blob/master/charts/tereo/values.yaml) describes the rest; [`ci/`](https://github.com/tereo-io/tereo/tree/master/charts/tereo/ci) has complete examples. Core's own
settings go under `env` (see [configuration](https://github.com/tereo-io/tereo/blob/master/packages/tereo/docs/configuration.md)).

Rendering fails, rather than core failing at start, on a missing `publicUrl` or `trustProxy`, a
non-https `publicUrl`, `trustProxy: "true"`, or no secret.

## How it runs

- **Migrations.** A Job runs the image's `migrate-and-seed.sh` as a pre-install and pre-upgrade
  hook, so the schema is current before core's pods start. ArgoCD runs it as a PreSync hook.
- **Files.** Core keeps file blobs on a volume (`persistence`), kept when the release is
  uninstalled. More than one core pod needs it to be `ReadWriteMany`: set `replicaCount` above 1
  or `worker.enabled` only on such a volume (or an `existingClaim` you know is shared).
- **Workers.** By default one Deployment runs everything (`ROLE=all`). `worker.enabled` splits the
  background workers into their own Deployment (`ROLE=worker`, health on port 4002).
- **Probes.** Readiness is `/health`, which reports 503 while Postgres or Redis is down; liveness
  only checks the port, so an outage does not restart core.

## First start

Core logs a one-time setup token until the first admin exists:

```sh
kubectl logs deploy/core-tereo | grep "not set up"
```

Complete setup at `${publicUrl}/setup`.
