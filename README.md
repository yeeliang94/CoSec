# CoSec Workspace

A company secretarial app for Malaysian private companies. It keeps company records, directors, members and their dated roles, prepares resolutions and director forms as Word documents, fills the SSM MBRS AR1 annual return workbook, and imports records from client files with AI help that a person reviews.

Built with Next.js, TypeScript and SQLite. It runs on one computer with no database server. All sample data is fictional, and no sample wording is approved legal precedent.

## Features

- **Company records:** particulars, addresses, business details, share capital, members, directors and other officers, with dated history and an audit log.
- **Resolutions:** reusable clauses and layouts, guided questions, optional colleague review, and Word (.docx) output with a kept history.
- **Director forms:** appointment and resignation documents generated from the company record.
- **AR1 annual return:** fills a blank AR1 workbook made in SSM's MBRS Preparation Tool (mTool) from the company record, ready to check and lodge.
- **Bulk import:** reads a client's files with an AI model, suggests company, people, share and charge records with their sources, and lets a reviewer correct and accept each one before it is applied. It needs an OpenAI-compatible model gateway, set on the Settings page, with its key in `.env` as `OPENAI_API_KEY`.
- **Access control:** Admin and User roles, company-level access and masking of identity numbers for users without access to them.

## Getting started

You need Node 24 LTS.

Double-click `start.bat` on Windows, or run `./start.sh` on macOS or Linux. It installs dependencies, creates a private settings file and a database with fictional sample data, builds the app, starts it and opens the browser. The sign-in details for the sample accounts are written to `.local/ACCOUNTS.md`.

The same steps by hand, in development mode:

```sh
npm ci
npm run db:provision   # first time only: private .env and empty database
npm run db:migrate
npm run db:seed        # fictional companies and staff, only into an empty database
npx tsx scripts/seed-resolution-samples.ts
npm run dev
npm run worker         # in another terminal
```

Then open http://127.0.0.1:4300.

## Checks

```sh
npm run typecheck
npm test
npm run build
npm run test:e2e       # browser tests; needs the app running and Playwright's Chromium
```

## Project layout

- `src/` the app: pages, components, server code and domain rules
- `migrations/` database schema changes, applied in order
- `scripts/` start-up, set-up and maintenance scripts
- `tests/` unit, integration and browser tests
- `design/canvas/` drawings of every screen; `DESIGN.md` holds the design rules and tokens

## Status

This is an evaluation build for use with fictional data. It does not connect to SSM, and no statutory rules or filing templates are bundled.
