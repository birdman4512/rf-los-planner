// Syntax-check the inline <script> blocks in a static HTML file.
//
// The planner ships as one self-contained index.html with all JS inline, so a
// single typo silently breaks the live site (there is no build step to catch
// it). This extracts every inline <script> (skipping external src= ones),
// writes each to a temp file, and runs `node --check` on it.
//
// Usage: node scripts/check-inline-js.mjs [file.html]

import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const file = process.argv[2] || 'index.html';
const html = readFileSync(file, 'utf8');

// Match every <script ...>...</script>; skip blocks that load an external src
// (nothing inline to check there).
const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const blocks = [];
let m;
while ((m = re.exec(html)) !== null) {
  const attrs = m[1] || '';
  if (/\bsrc\s*=/.test(attrs)) continue;
  const code = m[2];
  if (code.trim() === '') continue;
  const startLine = html.slice(0, m.index).split('\n').length;
  blocks.push({ code, startLine });
}

if (blocks.length === 0) {
  console.error(`No inline <script> found in ${file}`);
  process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), 'jscheck-'));
let failed = 0;

blocks.forEach((b, i) => {
  const tmp = join(dir, `inline-${i}.js`);
  writeFileSync(tmp, b.code);
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    console.log(`✓ inline script #${i + 1} (starts at ${file}:${b.startLine}) — syntax OK`);
  } catch (err) {
    failed++;
    const detail = (err.stderr || err.stdout || err.message || '').toString().trim();
    console.error(`✗ inline script #${i + 1} (starts at ${file}:${b.startLine}) — syntax error:`);
    console.error(detail);
  }
});

if (failed) {
  console.error(`\n${failed} inline script block(s) failed the syntax check.`);
  process.exit(1);
}
console.log(`\nAll ${blocks.length} inline script block(s) passed the syntax check.`);
