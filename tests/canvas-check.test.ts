import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const roots: string[] = [];
const checker = resolve('scripts/check-canvas.mjs');
const page = (body = '') => `<!doctype html><html><body><x-dc>${body}</x-dc></body></html>`;

function check(files: Record<string, string>, boards: string[], order = boards) {
  const root = mkdtempSync(join(tmpdir(), 'cosec-canvas-'));
  roots.push(root);
  const dir = join(root, 'design/canvas');
  mkdirSync(dir, { recursive: true });
  for (const [name, src] of Object.entries(files)) writeFileSync(join(dir, name), src);
  const index = {
    boards: Object.fromEntries(boards.map((b) => [b, { x: 0, y: 0, w: 10, h: 10 }])),
    order,
  };
  writeFileSync(join(dir, 'canvas.json'), JSON.stringify(index));
  return spawnSync(process.execPath, [checker], { cwd: root, encoding: 'utf8' });
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('design canvas check', () => {
  it('accepts a canvas whose links and imports all resolve', () => {
    const result = check(
      {
        'Main.dc.html': page(
          '<a href="Other.dc.html">x</a><dc-import tab="a" name="Other"></dc-import>',
        ),
        'Other.dc.html': page(),
      },
      ['Main.dc.html', 'Other.dc.html'],
    );
    expect(result.status).toBe(0);
  });

  it('rejects an artboard missing from canvas.json', () => {
    const result = check({ 'Main.dc.html': page(), 'Stray.dc.html': page() }, ['Main.dc.html']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Stray.dc.html is not listed in canvas.json boards');
  });

  it('rejects an order entry with no file', () => {
    const result = check(
      { 'Main.dc.html': page() },
      ['Main.dc.html'],
      ['Main.dc.html', 'Ghost.dc.html'],
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('order lists missing Ghost.dc.html');
  });

  it('rejects a broken link', () => {
    const result = check({ 'Main.dc.html': page('<a href="Gone.dc.html">x</a>') }, [
      'Main.dc.html',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Main.dc.html links to missing Gone.dc.html');
  });

  it('rejects a broken import even when name is not the first attribute', () => {
    const result = check(
      { 'Main.dc.html': page('<dc-import tab="x" name="CompanyHeadr"></dc-import>') },
      ['Main.dc.html'],
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('imports missing CompanyHeadr.dc.html');
  });
});
