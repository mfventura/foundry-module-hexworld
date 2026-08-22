/**
 * Smoke test: biome art defaults and Node-safety.
 *  - every biome id has a default path and the packaged file exists
 *  - configuredBiomeArt falls back to defaults without game.settings
 *  - biomeArtContext is null headless (renderer falls back to flat colors)
 * Run: node scratchpad/smoke-biome-art.mjs
 */
import "./mock-foundry.mjs";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { B } from "../scripts/generator/biomes.js";
import { DEFAULT_BIOME_ART, configuredBiomeArt, biomeArtContext } from "../scripts/render/biome-art.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;
function check(name, cond) {
  console.log(`${cond ? "ok" : "FAIL"} - ${name}`);
  if (!cond) failures++;
}

const ids = Object.values(B);
check("one default path per biome id", ids.every(id => typeof DEFAULT_BIOME_ART[id] === "string"));
check("no extra defaults", Object.keys(DEFAULT_BIOME_ART).length === ids.length);
check("default paths live under the module", Object.values(DEFAULT_BIOME_ART).every(p => p.startsWith("modules/hexworld/assets/biomes/")));
check("every packaged tile exists", Object.values(DEFAULT_BIOME_ART).every(p => existsSync(join(ROOT, p.replace("modules/hexworld/", "")))));

const conf = configuredBiomeArt();
check("configuredBiomeArt falls back to defaults headless", ids.every(id => conf[id] === DEFAULT_BIOME_ART[id]));

check("biomeArtContext is null headless", biomeArtContext({ grid: { size: 50, polys: [[0, 0]], cx: [0], cy: [0] } }) === null);
check("biomeArtContext tolerates a missing world", biomeArtContext(null) === null);

if (failures) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("smoke-biome-art: all good");
