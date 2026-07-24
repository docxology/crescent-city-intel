# Public Pages seed

This directory contains the reviewed, public municipal-code seed used when a
GitHub Actions checkout has no local `output/` directory. It contains only
public generated artifacts: the consolidated code export, TOC, manifest,
passing verification report, coverage, and readability data.

Refresh only after a successful scrape, verification, and export:

```bash
bun run pages:seed
```

The refresh script refuses to copy data unless
`output/verification-report.json` has `overallStatus: "pass"`. Live news,
meetings, alerts, YouTube, Triplicate metadata, curation, and reports are
collected separately by the Pages workflow and retain their own health states.
