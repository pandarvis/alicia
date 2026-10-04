import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { MASCOT_SOURCE_FILES, MASCOT_STATES } from "../src/shared/mascot.ts";

const SOURCE_DIR = fileURLToPath(new URL("../../../design/mascotte/papier-decoupe/v2/", import.meta.url));
const OUTPUT_DIR = fileURLToPath(new URL("../src/renderer/src/assets/mascot/", import.meta.url));
/** 2048 → 512: sharp enough at 160 px on a 2x screen, light enough to ship. */
const SIZE = 512;

mkdirSync(OUTPUT_DIR, { recursive: true });
for (const state of MASCOT_STATES) {
  const source = `${SOURCE_DIR}${MASCOT_SOURCE_FILES[state]}.png`;
  const output = `${OUTPUT_DIR}${state}.webp`;
  // Same square canvas for every pose: feet stay anchored, so cross-fades never jump.
  const info = await sharp(source).resize(SIZE, SIZE).webp({ quality: 85, alphaQuality: 90 }).toFile(output);
  console.log(`${state}.webp  ${Math.round(info.size / 1024)} Ko`);
}
