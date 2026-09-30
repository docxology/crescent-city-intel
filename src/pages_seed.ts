import { readPublicationBundle, stagePublicationSeed } from "./publication_bundle.js";
/** Prevalidate one bound edition, then promote the whole seed with rollback. */
export async function refreshPagesSeed(options: { sourceDir: string; destinationDir: string }): Promise<string[]> {
  const bundle = await readPublicationBundle(options.sourceDir);
  return stagePublicationSeed(bundle, options.destinationDir);
}
