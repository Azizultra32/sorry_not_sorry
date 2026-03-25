# Icons Needed

Chrome extensions require PNG icons. The following files must be added to this directory before the extension can be loaded unpacked or published:

| File        | Size       | Purpose                                      |
|-------------|------------|----------------------------------------------|
| icon16.png  | 16 × 16 px | Browser toolbar (small), favicon-size         |
| icon48.png  | 48 × 48 px | Extensions management page (chrome://extensions) |
| icon128.png | 128 × 128 px | Chrome Web Store listing and install dialog  |

## Design Guidance

Use a simple, recognizable design:
- A **film frame / clapperboard** or **video play symbol** as the primary shape
- A small **downward arrow** overlaid in the bottom-right corner to convey "download / archive"
- Suggested color: dark background (e.g. `#1a1a2e`) with a white or accent-colored icon (`#00d4ff` or similar)

## How to Generate

Option A — Use a vector editor (Figma, Illustrator, Inkscape) to draw the icon and export at each size.

Option B — Use a tool such as `sharp`, `imagemagick`, or an online PNG generator from an SVG source.

Option C — Use any free icon library (e.g. Heroicons, Phosphor Icons) with a download/video icon, then composite and export at the three required sizes.
