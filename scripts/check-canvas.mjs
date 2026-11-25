// Checks the repo copy of the design canvas (design/canvas): every artboard is listed in
// canvas.json, every listed artboard exists, and every link or import points at a real file.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = join(process.cwd(), 'design', 'canvas');
const files = new Set(readdirSync(dir).filter((f) => f.endsWith('.dc.html')));
const index = JSON.parse(readFileSync(join(dir, 'canvas.json'), 'utf8'));
const boards = new Set(Object.keys(index.boards ?? {}));
const order = new Set(index.order ?? []);
const problems = [];

for (const f of files) {
  if (!boards.has(f)) problems.push(`${f} is not listed in canvas.json boards`);
  if (!order.has(f)) problems.push(`${f} is not listed in canvas.json order`);
  const src = readFileSync(join(dir, f), 'utf8');
  for (const [, target] of src.matchAll(/href="([^"#:]+\.dc\.html)"/g)) {
    if (!files.has(target)) problems.push(`${f} links to missing ${target}`);
  }
  for (const [, name] of src.matchAll(/<dc-import\b[^>]*\bname="([^"]+)"/g)) {
    if (!files.has(`${name}.dc.html`)) problems.push(`${f} imports missing ${name}.dc.html`);
  }
}
for (const b of boards) if (!files.has(b)) problems.push(`canvas.json boards lists missing ${b}`);
for (const o of order) if (!files.has(o)) problems.push(`canvas.json order lists missing ${o}`);

if (problems.length) {
  console.error(`Design canvas check failed:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`Design canvas check passed (${files.size} artboards).`);
