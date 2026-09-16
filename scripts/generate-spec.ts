/**
 * Regenerates src/server/sandbox/api-spec.ts from Zod schemas.
 * Run: npm run generate:spec
 */
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateApiSpec } from "../src/server/sandbox/schemas/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const specPath = resolve(__dirname, "../src/server/sandbox/api-spec.ts");

const generated = generateApiSpec();
const escapedGenerated = generated.replaceAll("`", "\\`");

const fileContent = `\
/**
 * API_SPEC_TS snapshot — AUTO-GENERATED from Zod schemas in ./schemas/.
 * Run \`npm run generate:spec\` to regenerate. Do NOT edit manually.
 * Shape: flat globals (search, getFileContent, …); env.opengrok.* is equivalent.
 */
export const API_SPEC_TS = \`\\
${escapedGenerated}\`;

/** Backward-compatible alias. */
export const API_SPEC = API_SPEC_TS;

/** Method signatures extracted from the declaration string, keyed by method name. */
export const METHOD_SIGNATURES: Record<string, string> = {};
const sigRegex = /^(\\w+)\\(.*?\\).*?;/gm;
let match: RegExpExecArray | null;
while ((match = sigRegex.exec(API_SPEC_TS)) !== null) {
  METHOD_SIGNATURES[match[1]] = match[0];
}
`;

writeFileSync(specPath, fileContent, "utf8");
console.log(`api-spec snapshot regenerated (${generated.split("\n").length} lines)`);
