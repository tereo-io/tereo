---
"@tereo-io/sdk": patch
---

The package ships its TypeScript sources beside `dist/`, so its source maps and declaration maps resolve: a debugger steps into the SDK's own code, and an editor's go-to-definition opens it.
