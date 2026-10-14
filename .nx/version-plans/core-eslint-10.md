---
core: patch
---

Linted with ESLint 10. An SMTP host that fails to resolve now keeps the resolver's error as the `cause` of the one core logs; the delivery still records only "The SMTP host did not resolve".
