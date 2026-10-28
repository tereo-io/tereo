---
core: patch
---

Admin UI on `@kosmeo-ui/react` 1.2.0 (#36).

- **List rows by keyboard.** A clickable list's primary cell is a real link or button, so keyboard and screen-reader users can open a record. Middle-click, open in new tab and copy link work on the links, and a link no longer navigates twice.
- **Headings.** List pages have an `<h1>`.
- **Lists load once.** List pages fetch once on load instead of twice.
- **Forms.** Forms mark only the fields that fail, with a banner instead of a toast. The role name and organization slug are checked against core's rule before sending.
- **Narrow screens.** Filter bars fold behind a "Filters" toggle.
