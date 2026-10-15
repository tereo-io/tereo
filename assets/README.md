# Brand assets

| File | Use |
|---|---|
| `tereo-banner.svg` | 1200×500, the README header (`tereo-banner.png`: 2400×1000, where SVG is not rendered) |
| `tereo-mark.svg` | 256×256, avatars, the Helm chart icon and the admin UI's app icons (`tereo-mark.png` 256×256, `tereo-mark@2x.png` 512×512) |
| `tereo-favicon.svg` | 256×256 with heavier lines, for 16–32 px: the admin UI's favicons and top-bar mark |
| `tereo-social.svg` | 1280×640, the repository's social preview (`tereo-social.png` is the file GitHub takes, under *Settings → Social preview*) |

The wordmark and tagline are converted to outlines, so the SVGs need no fonts installed. The
typefaces are Michroma and Montserrat (SIL Open Font License).

The admin UI's icons in `packages/tereo-ui/public/` are rendered from these SVGs: `favicon.svg` is
`tereo-favicon.svg` as is; `favicon.ico` (16, 32 and 48 px), `favicon-16x16.png` and
`favicon-32x32.png` come from `tereo-favicon.svg`; `android-chrome-192x192.png`,
`android-chrome-512x512.png` and `apple-touch-icon.png` (180 px, flattened onto white, since iOS
fills transparency with black) come from `tereo-mark.svg`. Re-render them when a mark changes.
