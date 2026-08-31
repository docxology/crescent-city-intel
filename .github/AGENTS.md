# .github — agent notes

Two workflows (verified): pages.yml builds+publishes the static snapshot to
GitHub Pages (permissions: contents read, pages write, id-token write;
concurrency group github-pages; env includes AIRNOW_API_KEY secret,
SOURCE_DISCOVERY_LIVE_CHECK=1, PAGES_BUILD=1) and weekly.yml runs the weekly
intelligence cycle (schedule + workflow_dispatch with run_scrape boolean;
permissions contents read + actions read). Keep trigger times and env names in
sync when editing the workflows.
