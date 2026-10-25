#!/usr/bin/env node
/**
 * Dead-code verification harness.
 *
 * For each file reported by knip as "unused file", collect independent evidence:
 *   1. codegraph callers  — semantic call-graph evidence
 *   2. git grep (source)   — literal reference evidence in tracked source/config
 *   3. dynamic/indirect use heuristics — import(...), require(variable), string paths,
 *      json/html/config references
 *
 * Verdict:
 *   DEAD       — no codegraph callers, no source grep hit, no indirect signal
 *   KEEP       — any positive evidence of use
 *
 * Usage: node scripts/verify-dead-code.mjs [--files-only]
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = path.resolve(import.meta.dirname, "..");
const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const FILES_ONLY = process.argv.includes("--files-only");

const rel = (p) => path.relative(ROOT, p).split(path.sep).join("/");

function run(cmd, args, opts = {}) {
  try {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
  } catch (e) {
    return (e.stdout || "") + (e.stderr || "");
  }
}

/** Files to verify: CLI args, else knip's report. */
function collectFiles() {
  if (files.length) return files.map((f) => f.replace(/\\/g, "/"));
  let out = "";
  try {
    out = run("bunx", ["knip", "--no-progress", "--include", "files", "--reporter", "json"]);
  } catch (e) {
    out = e.stdout || "";
  }
  try {
    const j = JSON.parse(out);
    const set = new Set();
    for (const issue of j.issues || []) {
      for (const f of issue.files || []) if (f.name) set.add(f.name);
    }
    return [...set].sort();
  } catch {
    console.error("Failed to parse knip JSON. Pass files explicitly.");
    process.exit(2);
  }
}

/** Exported symbol names declared in a file (best-effort regex over the AST-free source). */
function exportedSymbols(file) {
  let src = "";
  try { src = fs.readFileSync(path.join(ROOT, file), "utf8"); } catch { return []; }
  const names = new Set();
  const pats = [
    /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /export\s+class\s+([A-Za-z_$][\w$]*)/g,
    /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /export\s+(?:interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
    /export\s*\{([^}]*)\}/g,
  ];
  for (const p of pats) {
    let m;
    p.lastIndex = 0;
    while ((m = p.exec(src)) !== null) {
      if (m[1] !== undefined) {
        if (/^[A-Za-z_$][\w$]*$/.test(m[1].trim())) names.add(m[1].trim());
      } else {
        for (const part of (m[2] || "").split(",")) {
          const id = part.split(/\s+as\s+/).pop().trim();
          if (id && /^[A-Za-z_$][\w$]*$/.test(id)) names.add(id);
        }
      }
    }
  }
  return [...names];
}

const SOURCE_DIRS = ["packages", "apps", "scripts", "workers", "infra"];

function gitGrep(term) {
  const out = run("git", ["grep", "-n", "--", term]);
  return out.split("\n").filter(Boolean);
}

/** Filter grep hits to real references (exclude the declaring file's own line noise). */
function meaningfulHits(hits, file, symbol) {
  const ownPath = file;
  return hits.filter((h) => {
    const f = h.split(":")[0];
    if (f === ownPath) return false;
    return true;
  });
}

// ---- main ----
const candidates = collectFiles();
console.log(`# Verifying ${candidates.length} knip-reported unused files\n`);

const verdicts = [];
for (const file of candidates) {
  const abs = path.join(ROOT, file);
  if (!fs.existsSync(abs)) continue;

  const symbols = exportedSymbols(file);
  const base = path.basename(file).replace(/\.[^.]+$/, "");

  const evidence = { file, exists: true, codegraph: [], grepSymbols: [], grepBase: [], indirect: [] };

  // 1. codegraph callers per exported symbol (semantic graph)
  for (const s of symbols.slice(0, 12)) {
    const out = run("codegraph", ["callers", s]);
    if (/No callers found|Callers of .*\(0\)/.test(out)) continue;
    const callers = out.split("\n")
      .map((l) => l.trim())
      .filter((l) => /^(?:[a-zA-Z0-9@._/-]+):[0-9]+/.test(l) || /\w+\.ts[x]?:[0-9]+/.test(l))
      .filter((l) => !l.includes(file));
    if (callers.length) evidence.codegraph.push({ symbol: s, callers: callers.slice(0, 4) });
  }

  // 2. git grep for basename + each symbol in tracked source/config
  const grepBase = gitGrep(base).filter((h) => h.split(":")[0] !== file);
  evidence.grepBase = grepBase.slice(0, 5);

  for (const s of symbols) {
    if (s === base || s === "default") continue;
    if (s.length < 4) continue;
    const hits = meaningfulHits(gitGrep(s), file, s);
    if (hits.length) evidence.grepSymbols.push({ symbol: s, hits: hits.slice(0, 3) });
  }

  // 3. indirect-use heuristics on the file itself
  const readSrc = () => { try { return fs.readFileSync(abs, "utf8"); } catch { return ""; } };
  const src = readSrc();
  if (/import\s*\(/.test(src)) evidence.indirect.push("dynamic import() present");
  if (/require\s*\(\s*[^'"`]/.test(src)) evidence.indirect.push("dynamic require() present");
  if (/\/\*.*@public|@internal/.test(src)) evidence.indirect.push("JSDoc public/internal tag");
  if (/^\s*export\s+default/m.test(src)) evidence.indirect.push("default export (framework/reflection candidate)");

  // Files discovered by name/glob by tooling (never imported): test runners use find
  // patterns, build scripts dispatch by platform name. These are live, not dead.
  if (/\.isolated\.[cm]?[jt]sx?$/.test(file)) {
    evidence.indirect.push("isolated test: discovered by root package.json test script (find -name '*.isolated.ts')");
  }
  if (/__(tests|mocks)__|\/(tests|test)\/|\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) {
    evidence.indirect.push("test file: run by 'bun test' runner (not imported)");
  }
  // Config/docs references prove the file is part of the documented surface.
  const configHits = gitGrep(file).filter((h) => /(package\.json|workflows\/|\.ya?ml|README|docs?\/|eslint\.config|\.md)/.test(h.split(":")[0]));
  if (configHits.length) evidence.indirect.push(`config/doc refs: ${configHits.slice(0, 2).map((h) => h.split(":")[0]).join(", ")}`);

  // search for string-literal path references to this file
  const relNoExt = file.replace(/\.[^.]+$/, "");
  const pathRefs = [];
  for (const dir of SOURCE_DIRS) {
    const absDir = path.join(ROOT, dir);
    if (!fs.existsSync(absDir)) continue;
  }
  const grepPath = gitGrep(relNoExt).filter((h) => h.split(":")[0] !== file);
  if (grepPath.length) evidence.indirect.push(`path refs: ${grepPath.slice(0, 3).join(" | ")}`);

  const codegraphEmpty = evidence.codegraph.length === 0;
  const grepEmpty = evidence.grepSymbols.length === 0 && evidence.grepBase.length === 0;
  const indirectEmpty = evidence.indirect.length === 0;

  const verdict = codegraphEmpty && grepEmpty && indirectEmpty ? "DEAD" : "KEEP";
  verdicts.push({ ...evidence, verdict, symbols });
}

// ---- report ----
const dead = verdicts.filter((v) => v.verdict === "DEAD");
const keep = verdicts.filter((v) => v.verdict === "KEEP");

console.log("=== DEAD (no callers, no refs, no indirect signal) ===");
for (const v of dead) console.log("  " + v.file);

console.log("\n=== KEEP (evidence found) ===");
for (const v of keep) {
  console.log(`  ${v.file}`);
  for (const c of v.codegraph) console.log(`      codegraph: ${c.symbol} <- ${c.callers.join(", ")}`);
  for (const g of v.grepSymbols) console.log(`      grep: ${g.symbol} -> ${g.hits.map((h) => h.split(":").slice(0, 2).join(":")).join(", ")}`);
  for (const i of v.indirect) console.log(`      indirect: ${i}`);
  if (v.grepBase.length && !v.grepSymbols.length) {
    console.log(`      grep(base '${path.basename(v.file).replace(/\.[^.]+$/, "")}'): ${v.grepBase.slice(0, 2).map((h) => h.split(":").slice(0, 2).join(":")).join(", ")}`);
  }
}

console.log(`\nTotals: DEAD ${dead.length} / KEEP ${keep.length} of ${verdicts.length}`);
