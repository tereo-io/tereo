---
core: patch
---

The admin UI's styles read `@kosmeo-ui/react`'s theme tokens by their `--k-` names. They used unprefixed names (`--primary-color`, `--text-color-light`, `--border-color` and others) that nothing defines, so the top bar, section sidebar, cards, borders and text fell back to browser defaults instead of the theme's colors.
