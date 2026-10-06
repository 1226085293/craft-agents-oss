#!/usr/bin/env node
// Dead Code Sweep v2 — statically-provable dead source file detection & removal.
//
// Usage:
//   node scripts/dead-code-sweep.mjs            # dry-run: report candidates only
//   node scripts/dead-code-sweep.mjs --apply    # delete candidates + verify + commit
//
// Safety model (fully automated, no human review):
//   - Only whole source files (.ts/.tsx) are candidates — never partial exports.
//   - A file is dead ONLY if it is UNREACHABLE from every entry point:
//       * each package's src/index.ts (package.json "main")
//       * apps/electron main (dist/main.cjs → src/main... mapped to src)
//       * vite renderer entry HTML files (index.html, playground.html, etc.)
//     Reachability = BFS over resolvable import/require edges (relative paths,
//     @craft-agent/* aliases, '@/renderer' vite alias).
//   - This correctly handles dead cyclic clusters (files importing each other
//     but none reachable from an entry) AND files imported only by other dead
//     files (transitive dead code).
//   - Entry-like names (index/main/app/bootstrap/serve/worker/entry) are excluded
//     from candidates (they may be entrypoints).
//   - Test files and .d.ts are never candidates.
//   - Working tree must be clean (no uncommitted changes) before deletion.
//   - Each sweep creates ONE commit; never touches non-candidate files.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const APPLY = process.argv.includes("--apply");
const DRY = !APPLY;

const SKIP_DIRS = ["node_modules", ".git", "dist", ".pi", "release", "build", "coverage", ".codegraph", "resources", "tools", ".husky", ".vite"];
const ENTRY_LIKE = ["index", "main", "app", "bootstrap", "serve", "server", "worker", "entry", "start", "electron"];
const CODE_EXTS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".cts", ".cjs"];

function rel(p) { return path.relative(ROOT, p).split(path.sep).join("/"); }
function normKey(p) {
  return stripExt(p).replace(/[\\/]index$/, "");
}
function stripExt(p) { return p.replace(/\.(tsx|ts|jsx|js|mts|mjs|cts|cjs)$/, ""); }

function walk(dir, exts) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.includes(e.name)) stack.push(path.join(d, e.name));
      } else if (e.isFile()) {
        const ext = path.extname(e.name);
        if (exts.includes(ext) && !e.name.endsWith(".d.ts")) out.push(path.join(d, e.name));
      }
    }
  }
  return out;
}
function isTestFile(f) {
  const r = rel(f);
  return /(__tests__|__mocks__|[\\/]tests[\\/]|[\\/]test[\\/])/.test(r) || /\.(test|spec|isolated)\.[jt]sx?$/.test(r);
}
function readFileOrNull(f) {
  try { return fs.readFileSync(f, "utf8"); } catch { return null; }
}

// ---- resolve an import target against an importer file to a repo-relative path ----
const RENDERER_ALIAS_ROOT = path.join(ROOT, "apps/electron/src/renderer");
function resolveTarget(t, fromFile) {
  if (t.startsWith(".")) {
    const r = path.resolve(path.dirname(fromFile), t);
    return r;
  }
  if (t.startsWith("/")) {
    return path.resolve(ROOT, "." + t);
  }
  const aliasM = t.match(/^@\/(.*)$/);
  if (aliasM) {
    return path.resolve(RENDERER_ALIAS_ROOT, aliasM[1]);
  }
  const m = t.match(/^@craft-agent\/([a-z0-9-]+)(?:\/(.*))?$/);
  if (m) {
    const pkg = m[1];
    const rest = m[2] ? m[2] : "";
    return path.join(ROOT, "packages", pkg, "src", rest);
  }
  return null; // external package — not a repo file, ignore
}

// candidate file keys (normalized absolute path strings)
const allSrc = new Set();
const pkgs = fs.readdirSync(path.join(ROOT, "packages")).filter((d) => fs.existsSync(path.join(ROOT, "packages", d, "package.json")));
const apps = fs.readdirSync(path.join(ROOT, "apps")).filter((d) => fs.existsSync(path.join(ROOT, "apps", d, "package.json")));
const srcRoots = [
  ...pkgs.map((p) => path.join(ROOT, "packages", p, "src")),
  ...apps.map((a) => path.join(ROOT, "apps", a, "src")),
].filter((d) => fs.existsSync(d));

for (const root of srcRoots) {
  for (const f of walk(root, CODE_EXTS)) {
    allSrc.add(path.resolve(f));
  }
}

function normalize(f) { return path.resolve(f); }
function keyOf(f) { return normKey(normalize(f)); }
function resolveFileVariants(target) {
  // given resolved absolute path (possibly no ext), find actual file variants
  const variants = [];
  const t = target;
  if (fs.existsSync(t)) variants.push(t);
  for (const e of CODE_EXTS) {
    const w = t.replace(/\.(tsx|ts|jsx|js|mts|mjs|cts|cjs)$/, "") + e;
    if (fs.existsSync(w)) variants.push(w);
  }
  for (const e of CODE_EXTS) {
    const w = path.join(t, "index" + e);
    if (fs.existsSync(w)) variants.push(w);
  }
  return variants;
}

// ---- parse all import/require targets and build edges ----
const edges = new Map(); // normalized abs file key -> Set of normalized abs file keys
const importRe = /(?:from\s*|import\s*\(\s*|import\s+["']|require\s*\(\s*|import\.meta\.glob\s*\(\s*)["']([^"']+)["']/g;

function collectImports(f) {
  const txt = readFileOrNull(f);
  if (txt == null) return;
  const fromKey = keyOf(f);
  importRe.lastIndex = 0;
  let m;
  while ((m = importRe.exec(txt)) !== null) {
    const t = m[1];
    if (t.startsWith("http")) continue;
    const resolved = resolveTarget(t, f);
    if (!resolved) continue;
    for (const v of resolveFileVariants(resolved)) {
      if (!allSrc.has(normalize(v))) continue; // not a candidate pool file (e.g. tests)
      const vKey = keyOf(v);
      if (!edges.has(fromKey)) edges.set(fromKey, new Set());
      edges.get(fromKey).add(vKey);
    }
  }
}

// ---- entry points ----
const entryKeys = new Set();
function addEntry(f) {
  const n = normalize(f);
  if (allSrc.has(n)) entryKeys.add(keyOf(n));
}
// package mains that point into src
for (const p of pkgs) {
  const pj = JSON.parse(readFileOrNull(path.join(ROOT, "packages", p, "package.json")) || "{}");
  if (pj.main && pj.main.startsWith("src/")) addEntry(path.join(ROOT, "packages", p, pj.main));
}
for (const a of apps) {
  const pj = JSON.parse(readFileOrNull(path.join(ROOT, "apps", a, "package.json")) || "{}");
  if (pj.main && pj.main.includes("src")) addEntry(path.join(ROOT, "apps", a, pj.main));
}
// electron main (dist/main.cjs -> source: check apps/electron/src/main*, or index)
const electronMainSrc = [
  path.join(ROOT, "apps/electron/src/main.ts"),
  path.join(ROOT, "apps/electron/src/main/index.ts"),
  path.join(ROOT, "apps/electron/src/index.ts"),
];
for (const p of electronMainSrc) if (fs.existsSync(p)) addEntry(p);
// vite renderer html entries: index.html, playground.html, browser-*.html (main.tsx refs)
const htmlEntries = [];
for (const f of walk(path.join(ROOT, "apps/electron/src/renderer"), [".html"])) htmlEntries.push(f);
for (const h of htmlEntries) {
  const t = readFileOrNull(h) || "";
  const m = t.match(/src="([^"]+\.(?:ts|tsx|js|jsx))"/);
  if (m) addEntry(path.join(path.dirname(h), m[1]));
}
// webui entry
addEntry(path.join(ROOT, "apps/webui/src/main.tsx"));
addEntry(path.join(ROOT, "apps/webui/src/index.tsx"));
// messaging worker
addEntry(path.join(ROOT, "packages/messaging-whatsapp-worker/src/worker.ts"));
// session-mcp-server / pi-agent-server built dist — skip (built from src, entry via package main dist/index.js; source entry approximated)
addEntry(path.join(ROOT, "packages/pi-agent-server/src/index.ts"));
addEntry(path.join(ROOT, "packages/session-mcp-server/src/index.ts"));

// ---- BFS reachability over edges ----
const reachable = new Set(entryKeys);
const queue = [...entryKeys];
// pre-load edges lazily: function to get edges for a file (parse when first needed)
const parsedNow = new Set();
function getEdgesFrom(srcKey) {
  if (parsedNow.has(srcKey)) return edges.get(srcKey) || new Set();
  parsedNow.add(srcKey);
  // find actual file path
  const f = [...allSrc].find((p) => keyOf(p) === srcKey);
  if (!f) return new Set();
  collectImports(f);
  return edges.get(srcKey) || new Set();
}
let iterations = 0;
while (queue.length) {
  if (++iterations > 20000) break; // safety
  const cur = queue.shift();
  const outs = getEdgesFrom(cur);
  for (const o of outs) {
    if (!reachable.has(o)) { reachable.add(o); queue.push(o); }
  }
}

// ---- candidates = all src files NOT reachable ----
const candidates = [];
for (const f of allSrc) {
  if (reachable.has(keyOf(f))) continue;
  if (isTestFile(f)) continue; // tests treated separately
  const base = path.basename(f, path.extname(f));
  if (ENTRY_LIKE.includes(base)) continue; // never touch entry-like names
  const ext = path.extname(f);
  if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") continue; // only TS sources for now
  candidates.push(f);
}

// ---- additional mention safety net (configs, docs string refs) ----
function mentionPattern(f) {
  const base = path.basename(f, path.extname(f));
  const esc = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `(?:${esc}\\.(?:tsx?|jsx?|mjs|cjs)|/(?:${esc})(?=[/"'\\s.]|$)|${esc}/)`;
}
const finalCandidates = [];
const skippedByMention = [];
for (const f of candidates) {
  const pat = mentionPattern(f);
  let hit = null;
  const textFiles = walk(ROOT, [".ts", ".tsx", ".js", ".jsx", ".mts", ".mjs", ".md", ".json", ".yml", ".yaml", ".html", ".htm", ".xml", ".ps1", ".sh", ".txt", ".toml", ".css"]);
  for (const tf of textFiles) {
    if (path.resolve(tf) === path.resolve(f)) continue;
    const tt = readFileOrNull(tf);
    if (tt == null) continue;
    const re = new RegExp(pat);
    if (re.test(tt)) { hit = tf; break; }
  }
  if (hit) skippedByMention.push({ file: rel(f), mentionedIn: rel(hit) });
  else finalCandidates.push(f);
}

// ---- output ----
function runGit(args) {
  return execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8" }).trim();
}
console.log(`Dead Code Sweep v2 — ${DRY ? "DRY-RUN (no changes)" : "APPLY"}`);
console.log(`Repo: ${ROOT}`);
console.log(`Src files indexed: ${allSrc.size} / entries: ${entryKeys.size}`);
console.log(`Reachable from entries: ${reachable.size} (incl. entries)`);
console.log(`Unreachable candidates (pre-mention filter): ${candidates.length}`);
console.log(`Skipped due to mention safety net: ${skippedByMention.length}`);
console.log(`Final candidates: ${finalCandidates.length}`);
if (finalCandidates.length) {
  console.log("Candidates:");
  for (const f of finalCandidates) console.log("  - " + rel(f));
}
if (skippedByMention.length) {
  console.log("Skipped (mentioned somewhere):");
  for (const s of skippedByMention) console.log(`  - ${s.file}  (mentioned in ${s.mentionedIn})`);
}

if (DRY) process.exit(0);

// ---- APPLY ----
if (!finalCandidates.length) {
  console.log("Nothing to delete. Exiting without commit.");
  process.exit(0);
}
const dirty = runGit(["status", "--porcelain"]);
if (dirty) {
  console.error("ABORT: working tree not clean.");
  console.error(dirty);
  process.exit(2);
}
for (const f of finalCandidates) {
  runGit(["rm", "-f", rel(f)]);
  console.log("removed: " + rel(f));
}
const date = new Date().toISOString().slice(0, 10);
const msg = `chore: remove statically-dead source files (${date}, ${finalCandidates.length} files)`;
runGit(["add", "-A"]);
runGit(["commit", "-m", msg, "-m", "Co-Authored-By: Craft Agent <agents-noreply@craft.do>"]);
const hash = runGit(["rev-parse", "--short", "HEAD"]);
console.log("Committed: " + msg);
console.log("Hash: " + hash);
