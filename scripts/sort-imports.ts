/**
 * Sorts TypeScript imports by length:
 * single-line imports first, longest to shortest, then multi-line imports by
 * the length of their last line. Side-effect imports that come before every
 * other import (`import "./preload.js"`) stay first, in order — they must run
 * before anything else is evaluated. A comment above the first import (a file
 * header) stays above the imports.
 *
 *   npx tsx scripts/sort-imports.ts [paths...]          # sort in place
 *   npx tsx scripts/sort-imports.ts --check [paths...]  # list unsorted files, exit 1 if any
 *
 * Paths are files or directories; the default is every package's `src/`.
 */
import path from "path";
import fs from "fs";

interface ImportStatement {
  original: string;
  isSingleLine: boolean;
  sortKey: number;
}

const SKIP_DIRS = new Set([
  "node_modules",
  "build",
  "dist",
  ".git",
  "generated",
]);
const isSideEffect = (statement: string) => /^import\s+["']/.test(statement);

function parseImports(content: string) {
  const lines = content.split("\n");
  const imports: ImportStatement[] = [];
  const importLines = new Set<number>();

  // The header — a shebang, then comments and blank lines — stays on top, but
  // only when an import follows it directly.
  const shebangLines = lines[0]?.startsWith("#!") ? 1 : 0;
  let start = shebangLines;
  while (start < lines.length && /^\s*(\/\/|\/\*|\*|$)/.test(lines[start])) {
    start++;
  }
  if (!lines[start]?.trim().startsWith("import ")) start = shebangLines;
  const header = lines.slice(0, start);
  for (let i = 0; i < start; i++) importLines.add(i);

  for (let i = start; i < lines.length; i++) {
    if (!lines[i].trim().startsWith("import ")) continue;
    const statement = [lines[i]];
    importLines.add(i);
    while (i < lines.length && !lines[i].includes(";")) {
      i++;
      if (i < lines.length) {
        statement.push(lines[i]);
        importLines.add(i);
      }
    }
    const original = statement.join("\n");
    const isSingleLine = statement.length === 1;
    imports.push({
      original,
      isSingleLine,
      sortKey: isSingleLine
        ? original.length
        : 100000 + statement[statement.length - 1].length,
    });
  }

  const rest = lines.filter((_, i) => !importLines.has(i));
  while (rest.length > 0 && rest[0].trim() === "") rest.shift();
  return { imports, restOfFile: rest.join("\n"), header };
}

function sortImports(imports: ImportStatement[]): string[] {
  let pinned = 0;
  while (pinned < imports.length && isSideEffect(imports[pinned].original)) {
    pinned++;
  }
  const rest = imports.slice(pinned);
  const byLength = (a: ImportStatement, b: ImportStatement) =>
    b.sortKey - a.sortKey;
  return [
    ...imports.slice(0, pinned),
    ...rest.filter((imp) => imp.isSingleLine).sort(byLength),
    ...rest.filter((imp) => !imp.isSingleLine).sort(byLength),
  ].map((imp) => imp.original);
}

/** The file's content with its imports sorted, or null if it has none. */
function sorted(content: string): string | null {
  const { imports, restOfFile, header } = parseImports(content);
  if (imports.length === 0) return null;
  const prefix = header.length > 0 ? header.join("\n") + "\n" : "";
  return prefix + sortImports(imports).join("\n") + "\n\n" + restOfFile;
}

function collect(target: string, out: string[]) {
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    if (/\.tsx?$/.test(target)) out.push(target);
    return;
  }
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    collect(path.join(target, entry.name), out);
  }
}

const args = process.argv.slice(2);
const check = args.includes("--check");
const root = path.resolve(import.meta.dirname, "..");
let targets = args.filter((a) => a !== "--check");
if (targets.length === 0) {
  targets = fs
    .readdirSync(path.join(root, "packages"))
    .map((pkg) => path.join(root, "packages", pkg, "src"))
    .filter((dir) => fs.existsSync(dir));
}

const files: string[] = [];
for (const target of targets) collect(path.resolve(target), files);

const unsorted: string[] = [];
for (const file of files) {
  const content = fs.readFileSync(file, "utf-8");
  const next = sorted(content);
  if (next === null || next === content) continue;
  unsorted.push(path.relative(root, file));
  if (!check) fs.writeFileSync(file, next);
}

if (check) {
  if (unsorted.length > 0) {
    console.error(
      `Imports not sorted in ${unsorted.length} file(s):\n  ${unsorted.join("\n  ")}\n` +
        "Run `npm run sort-imports` to fix."
    );
    process.exit(1);
  }
} else if (unsorted.length > 0) {
  console.log(`Sorted imports in ${unsorted.length} file(s)`);
}
