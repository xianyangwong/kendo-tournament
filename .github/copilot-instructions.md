- [x] Verify that the copilot-instructions.md file in the .github directory is created. Recreated after scaffolding.
- [x] Clarify Project Requirements. Confirmed a Vite React TypeScript app for kendo tournaments with single and team modes, single and double knockout, and a live diagram.
- [x] Scaffold the Project. Created the Vite React TypeScript app in the current folder and installed dependencies.
- [x] Customize the Project. Replaced the starter page with tournament setup forms, team roster ordering, and live bracket rendering.
- [x] Install Required Extensions. No extensions were required by the project setup information.
- [x] Compile the Project. `npm run build` passes.
- [x] Create and Run Task. No extra VS Code task was needed because `npm run dev` and `npm run build` already cover the workflow.
- [x] Launch the Project. The local dev server was started for validation; no separate debug launch was requested.
- [x] Ensure Documentation is Complete. README now documents the current application and this checklist is cleaned up.

## Design Context

### Users
Tournament officials and scorekeepers running live kendo events. Primary context: a laptop on a table courtside at a dojo or sports hall, often in variable lighting. The user is focused on the match happening in front of them — the interface must never require them to hunt for the right button. Decisions happen quickly; a wrong tap is friction under pressure.

### Brand Personality
**Deliberate · Ceremonial · Precise**

Kendo is defined by ritual, hierarchy, and disciplined form. Every element earns its place. The palette: washi paper (aged warmth), sumi ink (absolute authority), vermillion/shu (controlled energy), hakama indigo (structure). Push further into this territory, not away from it.

### Aesthetic Direction
- **Theme**: Light — tournaments run in brightly lit halls.
- **Typography**: Cormorant Garamond (display, italic), Shippori Mincho (kanji), Manrope (functional UI). Preserve this stack.
- **Visual language**: Restrained elegance with controlled bursts of vermillion. Ink on paper. Avoid glassmorphism, gradients, shadows competing for attention.
- **Density**: Scoring views scannable at arm's length. Hierarchy: **names → scores → controls**. Buttons are quiet until needed.
- **Motion**: Minimal. Brief state-change feedback only — nothing that pulls the eye during a live bout.

### Design Principles
1. **Courtside legibility first** — if a button or score isn't readable at 60cm in ambient hall lighting, it fails.
2. **Ceremony over decoration** — elements should feel like deliberate ritual choices, not UI embellishment.
3. **Hierarchy is fixed** — names most prominent, scores second, controls third.
4. **Nothing competes with the match** — the UI is a background instrument; it responds when addressed, never demands attention.
5. **Trust the palette** — washi/sumi/shu/indigo is distinctive and cohesive. New elements extend this system, don't introduce new colours.

### Page Priority
1. Fullscreen scoring (team + singles) — live, under pressure, sometimes projected
2. Match cards in bracket — primary interaction during an event
3. Home / tournament list — calm pre/post-event use
4. Setup wizard — one-time flow per tournament