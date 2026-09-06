# Bundled brand-script fonts

Fonts registered by `services/brandScriptRunner.child.js` before executing a brand's `styleScript`. Any font a brand script wants to reference by family name must have its `.ttf` (or `.otf`) file present in this directory.

## Registration convention

The runner iterates every `.ttf` / `.otf` in this dir and calls `GlobalFonts.registerFromPath(fullPath, familyName)` where `familyName` = the file name with the extension stripped (e.g. `Inter.ttf` → `Inter`, `Great-Vibes-Regular.ttf` → `Great-Vibes-Regular`).

**Name your files with the exact family name the brand script uses** — the seed scripts assume:

| File | Family name used in scripts |
|---|---|
| `Inter.ttf` | `Inter` |
| `Montserrat.ttf` | `Montserrat` |
| `GreatVibes.ttf` | `GreatVibes` |
| `Cormorant.ttf` | `Cormorant` |
| `Antonio.ttf` | `Antonio` |
| `Lora.ttf` | `Lora` |
| `PlayfairDisplay.ttf` | `PlayfairDisplay` |
| `DMSans.ttf` | `DMSans` |

## Sourcing

All fonts above are on Google Fonts (OFL license — commercial use OK, redistribute allowed). Download the family, unzip, drop the primary variable-weight `.ttf` (or the Regular / -Bold if not variable) in here. When a family is missing, node-canvas falls back to a system default — text still renders, but it won't look like the brand.

## Not committed by default

The initial commit ships this README only. Drop the TTFs in and commit them yourself when ready — or use a follow-up commit if we want the roster locked in.
