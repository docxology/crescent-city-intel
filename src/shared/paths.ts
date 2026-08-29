/** Centralized path resolution for output files */
import { OUTPUT_DIR, ARTICLES_DIR } from "../constants.js";

/**
 * The artifact-root seam. Production never sets CC_OUTPUT_DIR, so every path
 * below resolves exactly as it always has, relative to `output/`.
 *
 * A test that must WRITE points it at an os.tmpdir() directory. Before this
 * existed a test had nowhere else to write, so several wrote into the real
 * corpus and tried to undo it afterwards — an unsynchronised read-modify-write
 * on a shared name, which raced and left 381 fabricated meeting batches (one of
 * which the site published) plus a clobbered manifest. `scripts/validate.ts`
 * fences the corpus around the suite, so a new offender is now caught.
 *
 * These are getters, not computed literals: the env is re-read on every access,
 * so a test can scope the redirection to one block instead of the whole process.
 */
export function outputRoot(): string {
  return process.env.CC_OUTPUT_DIR ?? OUTPUT_DIR;
}

/** The articles directory, following outputRoot() when the seam is set. */
export function articlesRoot(): string {
  const root = process.env.CC_OUTPUT_DIR;
  return root ? `${root}/articles` : ARTICLES_DIR;
}

export const paths = {
  get output() { return outputRoot(); },
  get articles() { return articlesRoot(); },
  get toc() { return `${outputRoot()}/toc.json`; },
  get manifest() { return `${outputRoot()}/manifest.json`; },
  get verificationReport() { return `${outputRoot()}/verification-report.json`; },
  get monitorReport() { return `${outputRoot()}/monitor-report.json`; },
  get consolidatedJson() { return `${outputRoot()}/crescent-city-code.json`; },
  get plainText() { return `${outputRoot()}/crescent-city-code.txt`; },
  get sectionIndex() { return `${outputRoot()}/section-index.csv`; },
  get markdown() { return `${outputRoot()}/markdown`; },
  get state() { return `${outputRoot()}/state`; },
  get news() { return `${outputRoot()}/news`; },
  get newsSeenIds() { return `${outputRoot()}/state/news-seen-ids.json`; },
  get newsHealth() { return `${outputRoot()}/news/source-health.json`; },
  get govMeetings() { return `${outputRoot()}/gov_meetings`; },
  get govMeetingsHealth() { return `${outputRoot()}/gov_meetings/source-health.json`; },
  get youtube() { return `${outputRoot()}/youtube`; },
  get youtubeHealth() { return `${outputRoot()}/youtube/source-health.json`; },
  get triplicate() { return `${outputRoot()}/triplicate`; },
  get triplicateHealth() { return `${outputRoot()}/triplicate/source-health.json`; },
  get alertsHealth() { return `${outputRoot()}/alerts/source-health.json`; },
  get curated() { return `${outputRoot()}/curated`; },
  get curationSeen() { return `${outputRoot()}/state/curation-seen.json`; },
  get curationReport() { return `${outputRoot()}/state/curation-report.json`; },
  get analyticsOverview() { return `${outputRoot()}/state/analytics-overview.json`; },
  get manuscriptOutput() { return `${outputRoot()}/manuscript`; },
  get manuscriptVariables() { return `${outputRoot()}/data/manuscript_variables.json`; },
  get reports() { return `${outputRoot()}/reports`; },
  get latestReportMetadata() { return `${outputRoot()}/reports/latest-metadata.json`; },
  get weeklyCheckSummary() { return `${outputRoot()}/weekly-check-summary.json`; },
  get pipelineRun() { return `${outputRoot()}/state/latest-pipeline-run.json`; },
  get sourceRegistry() { return `${outputRoot()}/source-registry.json`; },
  get sourceDiscovery() { return `${outputRoot()}/source-discovery.json`; },
  get sourceDiscoverySeen() { return `${outputRoot()}/state/source-discovery-seen.json`; },
  get indexManifest() { return `${outputRoot()}/state/index-manifest.json`; },
  article: (guid: string) => `${articlesRoot()}/${guid}.json`,
  /** The search-query log the analytics surface reads; written only by the HTTP layer. */
  get searchQueryLog() { return `${outputRoot()}/search-queries.jsonl`; },
};
