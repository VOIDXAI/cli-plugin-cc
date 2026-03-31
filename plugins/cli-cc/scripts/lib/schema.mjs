import fs from "node:fs";

export function readOutputSchema(schemaPath) {
  return JSON.parse(fs.readFileSync(schemaPath, "utf8"));
}
