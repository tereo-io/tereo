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
- **External secrets.** The ExternalSecret is a hook too, ahead of the migration Job, so the
  Secret exists before anything reads it. It is recreated on each upgrade; the Secret it fills is
  orphaned and retained, so running pods never lose it.
- **Uninstall** leaves the files claim, and with `secrets.externalSecret` the ExternalSecret and its
  Secret, since Helm does not delete hooks. A reinstall picks them up again; delete them by hand to
  remove the app for good.
- **Probes.** Readiness is `/health`, which reports 503 while Postgres or Redis is down; liveness
  only checks the port, so an outage does not restart core.
- **Stopping.** An API pod sleeps `preStopSleepSeconds` (5) before core gets SIGTERM, so the ingress
  has stopped routing to it before it shuts down. Raise it if your ingress is slower to notice.

## More than one API pod

Core keeps no session in memory: rate limits, socket.io's cross-pod messages and the job queues are
in Redis, and each scheduled job runs once however many pods there are. Two things need setting:

- **A `ReadWriteMany` files volume**, shared by every pod (see *Files* above).
- **Sticky sessions for socket.io's long-polling fallback.** Clients connect by WebSocket first, which
  needs nothing. A client that cannot falls back to long-polling, and every request of that session
  must reach the pod that opened it; without stickiness most of them reach another pod and fail with
  400, and that client gets no live updates. With Traefik, set it on the Service:

  ```yaml
  replicaCount: 3
  service:
    annotations:
      traefik.ingress.kubernetes.io/service.sticky.cookie: "true"
      traefik.ingress.kubernetes.io/service.sticky.cookie.name: tereo_affinity
      traefik.ingress.kubernetes.io/service.sticky.cookie.secure: "true"
      traefik.ingress.kubernetes.io/service.sticky.cookie.httponly: "true"
  ```

  With ingress-nginx, on the Ingress: `ingress.annotations` with
  `nginx.ingress.kubernetes.io/affinity: cookie`.
  [`ci/replicas-values.yaml`](https://github.com/tereo-io/tereo/blob/master/charts/tereo/ci/replicas-values.yaml)
  is a complete example, with the pods spread across nodes.

## Provisioning

Declare services, login clients and roles as provisioning documents under `provisioning.documents`,
a map of name to document ([reference](https://github.com/tereo-io/tereo/blob/master/packages/tereo/docs/provisioning.md)).
The chart renders each as `<name>.json` in a ConfigMap, mounts it at `/etc/tereo/provisioning` and
sets `PROVISIONING_PATH`; with none, none of that is rendered. Or set `provisioning.existingConfigMap`
to mount a ConfigMap you manage. Core applies the documents at start, and a `post-install,post-upgrade`
Job (`provisioning.job`: backoff, deadline, resources) runs `provision` with core's environment, so a change takes effect without
restarting the pods. Never write a secret there: `secretFrom` names an environment variable, which
must be a key of the Secret in `secrets.existingSecret` (or come from `extraEnvFrom`). See
[`ci/provisioning-values.yaml`](https://github.com/tereo-io/tereo/blob/master/charts/tereo/ci/provisioning-values.yaml).

## First start

Core logs a one-time setup token until the first admin exists:

```sh
kubectl logs deploy/core-tereo | grep "not set up"
```

Complete setup at `${publicUrl}/setup`. To run it unattended, add `SETUP_TOKEN` (24 characters or
more) to the Secret: core then accepts it, logs no token, and ignores it once setup is done.
