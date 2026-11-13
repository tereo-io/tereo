---
"@tereo-io/mcp": patch
---

The README and `ToolContext.signal` now say what a client's cancel does on each protocol era: on a 2026-era connection it aborts `ctx.signal`; on a 2025-era (legacy) connection the `notifications/cancelled` it sends cannot reach the running call, which runs on until it ends or reaches its deadline. A disconnect aborts the signal on both.
