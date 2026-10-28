---
core: patch
---

Admin UI's top bar and section layout now come from `@kosmeo-ui/react` (`AppTopBar`, `SectionLayout`, `useMediaQuery`), replacing tereo's own copies.

- **Collapsed sidebar.** Collapsing a section's sidebar now shows its icons at full size, with the current page marked.
- **Keyboard.** Escape on the narrow-screen menu or sidebar drawer returns focus to the button that opened it.
- A sidebar collapsed before this release stays collapsed.
