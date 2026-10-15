---
core: minor
---

The Helm chart takes `service.annotations`, for sticky sessions when running more than one API pod (socket.io's long-polling fallback needs every request of a session on one pod), and gives API pods a `preStop` delay (`preStopSleepSeconds`, default 5) so the ingress stops routing to a pod before it shuts down.
