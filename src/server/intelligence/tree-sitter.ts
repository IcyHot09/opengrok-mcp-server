import {
  Parser,
  Language,
  Query,
  Tree as WasmTree,
  Node as WasmSyntaxNode,
  type QueryMatch as WasmQueryMatch,
} from "web-tree-sitter";
import path from "node:path";
import fs from "node:fs";
import { logger } from "../utils/logger.js";

export type Tree = WasmTree;
type TSLanguage = Language;
export type SyntaxNode = WasmSyntaxNode;
type QueryMatch = WasmQueryMatch;

const MAX_FILE_SIZE = 4_194_304; // 4 MB — covers large C++ files without hitting WASM limits

const LANGUAGE_GRAMMAR_MAP: Record<string, string> = {
  // --- C family ---
  c: "tree-sitter-c.wasm",
  cpp: "tree-sitter-cpp.wasm",
  cxx: "tree-sitter-cpp.wasm", // OpenGrok analyzer alias
  objc: "tree-sitter-objc.wasm",
  d: "tree-sitter-d.wasm",
  zig: "tree-sitter-zig.wasm",
  cuda: "tree-sitter-cuda.wasm",
  glsl: "tree-sitter-glsl.wasm",
  fortran: "tree-sitter-fortran.wasm",
  ada: "tree-sitter-ada.wasm",
  asm: "tree-sitter-asm.wasm",

  // --- JS/TS ecosystem ---
  javascript: "tree-sitter-javascript.wasm",
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  jsx: "tree-sitter-tsx.wasm", // TSX grammar parses JSX
  vue: "tree-sitter-vue.wasm",
  svelte: "tree-sitter-svelte.wasm",
  angular: "tree-sitter-angular.wasm",
  astro: "tree-sitter-astro.wasm",

  // --- JVM ---
  java: "tree-sitter-java.wasm",
  kotlin: "tree-sitter-kotlin.wasm",
  scala: "tree-sitter-scala.wasm",
  clojure: "tree-sitter-clojure.wasm",
  groovy: "tree-sitter-groovy.wasm",

  // --- Scripting / dynamic ---
  python: "tree-sitter-python.wasm",
  bash: "tree-sitter-bash.wasm",
  sh: "tree-sitter-bash.wasm", // OpenGrok analyzer alias
  powershell: "tree-sitter-powershell.wasm",
  perl: "tree-sitter-perl.wasm",
  ruby: "tree-sitter-ruby.wasm",
  php: "tree-sitter-php.wasm",
  lua: "tree-sitter-lua.wasm",
  r: "tree-sitter-r.wasm",
  elixir: "tree-sitter-elixir.wasm",
  erlang: "tree-sitter-erlang.wasm",
  elisp: "tree-sitter-elisp.wasm",
  scheme: "tree-sitter-scheme.wasm",
  racket: "tree-sitter-racket.wasm",
  commonlisp: "tree-sitter-commonlisp.wasm",
  julia: "tree-sitter-julia.wasm",
  matlab: "tree-sitter-matlab.wasm",
  nim: "tree-sitter-nim.wasm",
  awk: "tree-sitter-awk.wasm",
  fish: "tree-sitter-fish.wasm",

  // --- Systems / compiled ---
  go: "tree-sitter-go.wasm",
  golang: "tree-sitter-go.wasm", // OpenGrok analyzer alias
  rust: "tree-sitter-rust.wasm",
  csharp: "tree-sitter-c_sharp.wasm",
  c_sharp: "tree-sitter-c_sharp.wasm",
  haskell: "tree-sitter-haskell.wasm",
  ocaml: "tree-sitter-ocaml.wasm",
  ocaml_interface: "tree-sitter-ocaml_interface.wasm",
  ocaml_type: "tree-sitter-ocaml_type.wasm",
  dart: "tree-sitter-dart.wasm",
  swift: "tree-sitter-swift.wasm",
  gleam: "tree-sitter-gleam.wasm",
  solidity: "tree-sitter-solidity.wasm",
  systemverilog: "tree-sitter-systemverilog.wasm",
  devicetree: "tree-sitter-devicetree.wasm",

  // --- Markup / web ---
  html: "tree-sitter-html.wasm",
  css: "tree-sitter-css.wasm",
  scss: "tree-sitter-scss.wasm",
  xml: "tree-sitter-xml.wasm",
  dtd: "tree-sitter-dtd.wasm",
  markdown: "tree-sitter-markdown.wasm",
  latex: "tree-sitter-latex.wasm",
  bibtex: "tree-sitter-bibtex.wasm",
  typst: "tree-sitter-typst.wasm",
  graphql: "tree-sitter-graphql.wasm",
  prisma: "tree-sitter-prisma.wasm",
  qmljs: "tree-sitter-qmljs.wasm",
  templ: "tree-sitter-templ.wasm",
  liquid: "tree-sitter-liquid.wasm",

  // --- Data / config / infra ---
  json: "tree-sitter-json.wasm",
  yaml: "tree-sitter-yaml.wasm",
  toml: "tree-sitter-toml.wasm",
  ini: "tree-sitter-ini.wasm",
  hcl: "tree-sitter-hcl.wasm",
  terraform: "tree-sitter-hcl.wasm", // HCL grammar covers Terraform
  sql: "tree-sitter-sql.wasm",
  csv: "tree-sitter-csv.wasm",
  tsv: "tree-sitter-tsv.wasm",
  psv: "tree-sitter-psv.wasm",
  dockerfile: "tree-sitter-dockerfile.wasm",
  make: "tree-sitter-make.wasm",
  cmake: "tree-sitter-cmake.wasm",
  nginx: "tree-sitter-nginx.wasm",
  diff: "tree-sitter-diff.wasm",
  gitignore: "tree-sitter-gitignore.wasm",
  gitattributes: "tree-sitter-gitattributes.wasm",
  git_config: "tree-sitter-git_config.wasm",
  editorconfig: "tree-sitter-editorconfig.wasm",
  desktop: "tree-sitter-desktop.wasm",
  requirements: "tree-sitter-requirements.wasm",
  kdl: "tree-sitter-kdl.wasm",
  jq: "tree-sitter-jq.wasm",
  regex: "tree-sitter-regex.wasm",
  query: "tree-sitter-query.wasm",
  comment: "tree-sitter-comment.wasm",

  // --- Game dev ---
  gdscript: "tree-sitter-gdscript.wasm",
  gdshader: "tree-sitter-gdshader.wasm",
  godot_resource: "tree-sitter-godot_resource.wasm",

  // --- Misc ---
  elm: "tree-sitter-elm.wasm",
  embedded_template: "tree-sitter-embedded_template.wasm",
  just: "tree-sitter-just.wasm",
  arduino: "tree-sitter-arduino.wasm",
  cairo: "tree-sitter-cairo.wasm",
  git_rebase: "tree-sitter-git_rebase.wasm",
  markdown_inline: "tree-sitter-markdown_inline.wasm",
  nix: "tree-sitter-nix.wasm",
  php_only: "tree-sitter-php_only.wasm",
  proto: "tree-sitter-proto.wasm",
  razor: "tree-sitter-razor.wasm",
  sln: "tree-sitter-sln.wasm",
  ssh_config: "tree-sitter-ssh_config.wasm",
  vim: "tree-sitter-vim.wasm",
  vimdoc: "tree-sitter-vimdoc.wasm",
};

let initialized = false;
let initPromise: Promise<void> | null = null;
const languageCache = new Map<string, TSLanguage>();
const languageLoadPromises = new Map<string, Promise<TSLanguage | null>>();
const failedLanguages = new Set<string>();

async function ensureInit(): Promise<void> {
  if (!initialized) {
    // Guard: if Parser.init() hangs (e.g. WASM file missing from bundle path),
    // a 10s timeout prevents the background task from hanging permanently.
    initPromise ??= Promise.race([
      Parser.init().then(() => { initialized = true; }),
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error("Parser.init() timed out — tree-sitter.wasm not found in bundle directory")), 10_000)),
    ]).catch((err) => { console.error("[tree-sitter] init failed:", err); initPromise = null; throw err; });
    await initPromise;
  }
}

function getGrammarDir(): string {
  if (process.env.OPENGROK_GRAMMAR_DIR) return process.env.OPENGROK_GRAMMAR_DIR;
  // Walk up from __dirname to find grammars/ (works in both source and bundle).
  // Also probe out/grammars/ at each level: grammars/ is gitignored so a fresh
  // checkout (e.g. CI) only has out/grammars/ populated by `npm run compile`.
  let dir = __dirname;
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, "grammars");
    if (fs.existsSync(candidate)) return candidate;
    const outCandidate = path.join(dir, "out", "grammars");
    if (fs.existsSync(outCandidate)) return outCandidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.join(__dirname, "..", "grammars");
}

async function loadLanguage(lang: string): Promise<TSLanguage | null> {
  const cached = languageCache.get(lang);
  if (cached !== undefined) return cached;
  if (failedLanguages.has(lang)) return null;

  // Deduplicate concurrent load calls — all callers share the same in-flight promise.
  // Without this, multiple concurrent callers each invoke Parser.Language.load()
  // simultaneously, which can deadlock the WASM runtime.
  if (!languageLoadPromises.has(lang)) {
    const p: Promise<TSLanguage | null> = (async () => {
      const grammarFile = LANGUAGE_GRAMMAR_MAP[lang];
      if (!grammarFile) return null;

      const grammarPath = path.join(getGrammarDir(), grammarFile);
      if (!fs.existsSync(grammarPath)) {
        console.warn(`Grammar file not found: ${grammarPath}`);
        failedLanguages.add(lang);
        return null;
      }

      try {
        const language = await Language.load(grammarPath);
        languageCache.set(lang, language);
        return language;
      } catch (err) {
        console.warn(`Failed to load grammar for ${lang}:`, err);
        failedLanguages.add(lang);
        return null;
      }
    })();
    languageLoadPromises.set(lang, p);
    void p.finally(() => languageLoadPromises.delete(lang));
  }
  return languageLoadPromises.get(lang) ?? null;
}

export function isLanguageSupported(language: string): boolean {
  return language in LANGUAGE_GRAMMAR_MAP;
}

/**
 * Best-effort startup probe: log how many tree-sitter grammars are present
 * vs missing in the resolved grammar directory. Never throws — an invalid
 * OPENGROK_GRAMMAR_DIR only disables tree-sitter intelligence (all load
 * paths already null-guard on failure).
 */
export function logGrammarStatus(): void {
  try {
    const dir = getGrammarDir();
    let present: Set<string>;
    try {
      present = new Set(fs.readdirSync(dir));
    } catch {
      logger.warn(`[tree-sitter] grammar dir unreadable (${dir}) — code intelligence disabled. Check OPENGROK_GRAMMAR_DIR.`);
      return;
    }
    const needed = new Set(Object.values(LANGUAGE_GRAMMAR_MAP));
    const missing = [...needed].filter((f) => !present.has(f));
    if (missing.length === 0) {
      logger.info(`[tree-sitter] ${needed.size} grammars loaded from ${dir}.`);
    } else {
      logger.warn(`[tree-sitter] ${needed.size - missing.length}/${needed.size} grammars loaded from ${dir}; missing: ${missing.sort().join(", ")}.`);
    }
  } catch { /* never crash startup */ }
}

export async function parseSource(
  content: string,
  language: string,
): Promise<Tree | null> {
  if (!content || content.length > MAX_FILE_SIZE) return null;
  if (!isLanguageSupported(language)) return null;

  try {
    await ensureInit();
  } catch {
    return null;
  }
  const lang = await loadLanguage(language);
  if (!lang) return null;

  const parser = new Parser();
  try {
    parser.setLanguage(lang);
    const tree = parser.parse(content);
    return tree;
  } catch {
    return null;
  } finally {
    parser.delete();
  }
}

// Compiled-query cache keyed by language + query text. The key space is fixed
// (query strings are code constants, ~20 total), so no eviction is needed;
// entries live for the process lifetime (KBs). Callers must never delete
// cached queries.
const queryCache = new Map<string, Query>();

function getCachedQuery(lang: TSLanguage, language: string, queryString: string): Query {
  const key = `${language}\n${queryString}`;
  const hit = queryCache.get(key);
  if (hit) return hit;
  const query = new Query(lang, queryString);
  queryCache.set(key, query);
  return query;
}

export function queryNodes(  tree: Tree,
  queryString: string,
  language: string,
): QueryMatch[] {
  const lang = languageCache.get(language);
  if (!lang) return [];

  try {
    // web-tree-sitter 0.26+: queries are constructed standalone (Language.query() was removed)
    const query = getCachedQuery(lang, language, queryString);
    return query.matches(tree.rootNode);
  } catch {
    return [];
  }
}
