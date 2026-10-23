import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { indexNewLeaves } from '../../src/services/memory-tree/MemoryTree.js';
import { treeContextSection } from '../../src/services/memory-tree/context-section.js';

// Fork Phase 2: the SessionStart block gains a tree section for an enabled
// project: a header that frames it as data and names the zoom tool, then the
// view, all within the configured characters.
function dbWith(n: number): Database {
  const db = new Database(':memory:');
  new SessionStore(db);
  db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch, status)
    VALUES ('c', 'm', 'p', 'claude', '2026-10-01T00:00:00.000Z', 1, 'active')`).run();
  const insert = db.prepare(`INSERT INTO observations (memory_session_id, project, type, title, created_at, created_at_epoch)
    VALUES ('m', 'p', 'discovery', ?, '2026-10-01T00:00:00.000Z', ?)`);
  for (let i = 0; i < n; i++) insert.run(`observation ${i}`, i + 1);
  indexNewLeaves(db, 'p');
  return db;
}

describe('treeContextSection', () => {
  it('frames the view as data, names memory_zoom and fits the budget', () => {
    const section = treeContextSection(dbWith(300), 'p', { projects: 'p', viewChars: 3000 });
    expect(section.length).toBeLessThanOrEqual(3000);
    expect(section).toContain('memory_zoom');
    expect(section).toMatch(/data[^.]*not instructions/i);
    expect(section).toContain('[L0:299]');
  });

  it('is empty for a project the setting does not name, or with no leaves', () => {
    expect(treeContextSection(dbWith(3), 'p', { projects: 'other', viewChars: 3000 })).toBe('');
    expect(treeContextSection(dbWith(0), 'p', { projects: 'p', viewChars: 3000 })).toBe('');
  });
});
