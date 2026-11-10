import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { allResources } from "../src/cli.js";
import { defaultIo } from "../src/core.js";
import { renderSkill } from "../src/skill.js";

// dist/scripts/build-skill.js → repo root
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const target = join(root, "skills", "lexware-office-axi", "SKILL.md");
const content = renderSkill(allResources(defaultIo));

if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {
    // missing counts as stale
  }
  if (current !== content) {
    process.stdout.write("skill: stale\nhelp[1]: Run `npm run build && npm run build:skill` and commit skills/lexware-office-axi/SKILL.md\n");
    process.exitCode = 1;
  } else {
    process.stdout.write("skill: up to date\n");
  }
} else {
  writeFileSync(target, content);
  process.stdout.write(`skill: written to ${target}\n`);
}
