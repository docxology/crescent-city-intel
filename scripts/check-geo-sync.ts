#!/usr/bin/env bun
import { checkGeoSync } from "../src/geo_sync.js";
process.exitCode = await checkGeoSync();
