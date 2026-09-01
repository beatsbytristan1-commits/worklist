# Worklist

Checklists, store-staging progress and a calendar, in one small app.

There are two ways to run it:

| | Where the data lives | Notes |
|---|---|---|
| **Hosted** — [open the app](https://beatsbytristan1-commits.github.io/worklist/) | private `worklist-data` repo | works from any device, every save is a commit |
| **Local** — `node server.js` | `data/state.json` on this Mac | live sync over the LAN, runs as a launch agent |

## What it does

- **Lists and checklists**, grouped into collapsible sections
- **Steps per row** (e.g. *On the bench* → *Staged*) with partial counts, so `12/19` of a line can be done
- **Calendar** with multi-day bars, drag to move or stretch, and lists that schedule themselves
- **Excel import** for Smartsheet BOM exports — reads the hierarchy and skips sub-rows
- **Progress reports** as a printable page, CSV, or plain text to paste into an email
- **Undo/redo**, daily snapshots, and cross-device sync

## Layout

```
public/index.html   the app (single source of truth)
server.js           local zero-dependency server
xlsx.js             minimal .xlsx reader, no dependencies
report.js           progress report as HTML / CSV / text
build-web.js        builds web/ for GitHub Pages from public/index.html
web-extra.js        the GitHub-storage layer used by that build
```

Rebuild the hosted version after changing the app:

```sh
node build-web.js && git add web && git commit -m "rebuild" && git push
```

No dependencies anywhere — Node's standard library only.
