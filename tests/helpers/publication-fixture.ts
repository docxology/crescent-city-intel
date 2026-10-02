/** Synthetic same-edition hashes exercise the contract; they are never live acceptance. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { articleSetSha256 } from "../../src/corpus_editions.ts";
import { publicationHash } from "../../src/publication_bundle.ts";
import { currentCivicProfile, municipalCodeId } from "../../src/civic_profile.ts";
import type { ArticlePage } from "../../src/types.ts";
export async function writePublicationFixture(root: string, text = "Crescent City fixture", customArticles?: ArticlePage[]): Promise<void> {
  await mkdir(root, { recursive: true });
  const article = { guid: "article-1", title: "General", number: "1", url: "https://ecode360.com/article-1", sha256: publicationHash("fixture source"), sections: [{ guid: "section-1", number: "§ 1.01.010", title: "Purpose", text, history: "" }] };
  const articles = customArticles ?? [article as unknown as ArticlePage];
  const manifest = `${JSON.stringify({ articles: Object.fromEntries(articles.map(row => [row.guid, { sha256: row.sha256, sectionCount: row.sections.length }])), articlePageCount: articles.length, sectionCount: articles.reduce((sum, row) => sum + row.sections.length, 0) })}\n`;
  const toc = `${JSON.stringify({ guid: municipalCodeId(), type: "code", tocName: currentCivicProfile().municipality, children: articles.map(row => ({ guid: row.guid, type: "article", children: row.sections.map(section => ({ guid: section.guid, type: "section", children: [] })) })) })}\n`;
  const verification = { overallStatus: "pass", publicationEligible: true, evidence: { currentToc: "ecode360-live", sample: "ecode360-live", limitations: ["synthetic fixture, not live evidence"] }, planes: { local: "pass", currentToc: "pass", sample: "pass" }, binding: { manifestSha256: publicationHash(manifest), tocSha256: publicationHash(toc), articleSetSha256: articleSetSha256(articles) } };
  for (const [file, bytes] of Object.entries({ [`${currentCivicProfile().corpusSlug}.json`]: `${JSON.stringify({ municipality: currentCivicProfile().municipality, guid: municipalCodeId(), source: `https://ecode360.com/${municipalCodeId()}`, articles })}\n`, "manifest.json": manifest, "toc.json": toc, "verification-report.json": `${JSON.stringify(verification)}\n` })) await writeFile(join(root, file), bytes);
}

/** Retained reviewed municipal text in a bounded contract fixture, never live acceptance. */
export async function writeReviewedPublicationFixture(root: string, articleCount = 6): Promise<void> {
  const seed = JSON.parse(await readFile(join(import.meta.dir, "../../pages-data/crescent-city-code.json"), "utf8")) as { articles: ArticlePage[] };
  const articles = seed.articles.filter(article => article.sections.length > 0).slice(0, articleCount);
  if (articles.length !== articleCount) throw new Error("Reviewed Pages fixture lacks its declared representative articles");
  await writePublicationFixture(root, "", articles);
  // The browser journey also renders the real reviewed directory. Retain that
  // bounded public fixture without falling back to the entire municipal seed.
  await writeFile(join(root, "directory.json"), await readFile(join(import.meta.dir, "../../pages-data/directory.json")));
}
