import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { indexNewLeaves } from '../../src/services/memory-tree/MemoryTree.js';
import { viewFilePath, writeViewFile } from '../../src/services/memory-tree/view-file.js';

// Fork Phase 2 (2f): the worker rewrites ~/.claude-mem/views/<project>.md for
// a CLAUDE.local.md to import, so a session can start with more of the tree
// than the 10,000-char hook limit allows. Whole file or nothing, private, framed as data.
let db: Database;
let dir: string;

beforeEach(() => {
  db = new Database(':memory:');
  new SessionStore(db);
  db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch, status)
    VALUES ('c', 'm', 'my/proj', 'claude', '2026-10-01T00:00:00.000Z', 1, 'active')`).run();
  const insert = db.prepare(`INSERT INTO observations (memory_session_id, project, type, title, created_at, created_at_epoch)
    VALUES ('m', 'my/proj', 'discovery', ?, '2026-10-01T00:00:00.000Z', ?)`);
  for (let i = 0; i < 2000; i++) insert.run(`observation number ${i}`, i + 1);
  indexNewLeaves(db, 'my/proj');
  dir = mkdtempSync(join(tmpdir(), 'tree-views-'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('writeViewFile', () => {
  it('writes the header and view within the byte budget, 0600, under a safe name', () => {
    const path = writeViewFile(db, 'my/proj', dir, 20_000)!;
    expect(path).toBe(viewFilePath(dir, 'my/proj'));
    expect(path.startsWith(dir)).toBe(true);
    expect(path).not.toContain('my/proj');
    const text = readFileSync(path, 'utf-8');
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(20_000);
    expect(text).toContain('memory_zoom');
    expect(text).toMatch(/not instructions/);
    expect(text).toContain('[L0:1999]');
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('leaves no temporary file behind', () => {
    writeViewFile(db, 'my/proj', dir, 20_000);
    writeViewFile(db, 'my/proj', dir, 20_000);
    expect(readdirSync(dir)).toEqual([readdirSync(dir).find(name => name.endsWith('.md'))!]);
  });

  it('writes nothing when the budget is 0', () => {
    expect(writeViewFile(db, 'my/proj', dir, 0)).toBeNull();
    expect(existsSync(viewFilePath(dir, 'my/proj'))).toBe(false);
  });
});
