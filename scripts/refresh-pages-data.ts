#!/usr/bin/env bun
/** Refresh the tracked, public municipal-code seed from verified output. */
import { refreshPagesSeed } from "../src/pages_seed.ts";

const sourceDir = process.env.OUTPUT_DIR ?? "output";
const destinationDir = process.env.PAGES_SEED_DIR ?? "pages-data";
const seeded = await refreshPagesSeed({ sourceDir, destinationDir });
console.log(`Public Pages seed refreshed in ${destinationDir}: ${seeded.join(", ")}`);
