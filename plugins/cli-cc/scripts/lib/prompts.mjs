import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

export function loadPromptTemplate(name) {
  const promptPath = path.join(ROOT_DIR, "prompts", `${name}.md`);
  return fs.readFileSync(promptPath, "utf8");
}

export function interpolateTemplate(template, variables) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
    return Object.prototype.hasOwnProperty.call(variables, key) ? String(variables[key] ?? "") : "";
  });
}
