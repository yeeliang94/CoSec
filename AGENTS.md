# CoSec Workspace

Read [DESIGN.md](DESIGN.md) before any UI, component, layout, typography or content-presentation change. Its tokens, component rules and the "Refresh rules" section are the visual authority.

Keep legal and regulatory rules tied to approved sources and versions. Preserve unrelated local changes and validate the user path affected by each change.

If `AGENTS.local.md` exists, read it too. It holds notes for one machine and is not committed.

## Design canvas

`design/canvas/` draws every screen, tab and popup of the app. Any change to what a screen shows updates its canvas file in the same commit, and a new screen, tab or popup gets a new one. Reviews flag a UI change whose canvas file was left untouched. Read [design/canvas/README.md](design/canvas/README.md) before editing it, and run `npm run check:canvas` after.

## Validation

The application is used on desktop computers only. When validating UI work, check desktop widths (1280px and 1440px) with keyboard focus and real-length data. Do not test, screenshot or fix phone or tablet layouts. Run `npm run typecheck` and `npm test`. Run Playwright specs (`npm run test:e2e`) only when asked for them in the current task, not as routine validation or as part of a code review. They use Playwright's own Chromium; if it is missing, run `npx playwright install chromium`. Start the app with `npm run dev`, not `./start.sh`, which opens a browser.

## Settings and secrets

Settings and feature switches live on the app's Settings page. `.env` holds only secrets and API keys. Never commit `.env`, `.local/` or real client data.
