# Design canvas

Drawings of every screen, tab and popup in the app. Each `*.dc.html` file is one artboard; `canvas.json` holds the layout (position, size and title of every artboard, plus the row headings).

- **Shared parts.** `Sidebar`, `CompanyHeader` (with a `tab` prop), `CompanyDetails` and `ResolutionPreview` are pulled into other screens with `<dc-import>`.
- **Pages.** One file per page or tab, at 1440 × 900.
- **Popups.** A drawer, dialog or menu is its own file that imports the page it opens from, then draws a backdrop and the popup over it.
- **Format.** Inline styles that match the DESIGN.md tokens; links between screens are `<a href="Other.dc.html">`; sample data is fictional.

Run `npm run check:canvas` after any change. It passes when every artboard is listed in `canvas.json` and every link and import points to a file in this folder.
