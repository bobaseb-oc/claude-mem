import { beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import {
  createMemoryTreeSchema,
  deleteTreeOfRow,
  indexNewLeaves,
  leafCount,
  parseTreeProjects,
  readyMerges,
  renderTreeView,
  storeMerge,
  zoomNode,
} from '../../src/services/memory-tree/MemoryTree.js';

// Fork Phase 2 (tasks/todo.md): a project's observations and prompts are the
// leaves of a binary tree of one-line summaries, numbered in the order the tree
// first sees them. The view covers the whole history in a budget, recent work
// in detail; zoom opens any line into the two it was made from.

const PROJECT = 'proj-tree';
let db: Database;
let clock = 1_760_000_000_000;

function seedSession(contentSessionId = 'content-tree'): number {
  db.prepare(`INSERT OR IGNORE INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch, status)
    VALUES (?, ?, ?, 'claude', '2026-10-01T00:00:00.000Z', 1759276800000, 'active')`).run(contentSessionId, `memory-${contentSessionId}`, PROJECT);
  return (db.prepare('SELECT id FROM sdk_sessions WHERE content_session_id = ?').get(contentSessionId) as { id: number }).id;
}

function addObservation(title: string, at = (clock += 1000)): number {
  return Number(db.prepare(`INSERT INTO observations (memory_session_id, project, type, title, narrative, created_at, created_at_epoch)
    VALUES ('memory-content-tree', ?, 'discovery', ?, ?, '2026-10-01T00:00:00.000Z', ?)`).run(PROJECT, title, `narrative of ${title}`, at).lastInsertRowid);
}

let promptNumber = 0;
function addPrompt(text: string, at = (clock += 1000)): number {
  const sessionDbId = seedSession();
  return Number(db.prepare(`INSERT INTO user_prompts (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
    VALUES (?, 'content-tree', ?, ?, '2026-10-01T00:00:00.000Z', ?)`).run(sessionDbId, ++promptNumber, text, at).lastInsertRowid);
}

/** Builds every ready node, bottom up, with a text that names its children's ids. */
function buildAll(text = (level: number, idx: number, older: string, newer: string) => `L${level}:${idx} <${older.slice(0, 20)}|${newer.slice(0, 20)}>`): void {
  for (;;) {
    const ready = readyMerges(db, PROJECT, 1000);
    if (ready.length === 0) return;
    for (const merge of ready) storeMerge(db, PROJECT, merge.level, merge.idx, text(merge.level, merge.idx, merge.older, merge.newer));
  }
}

/** The leaf ranges [from, to) a rendered view's lines cover, in order. */
function coveredRanges(view: string): Array<[number, number]> {
  return [...view.matchAll(/\[L(\d+):(\d+)\]/g)].map(([, l, i]) => {
    const width = 2 ** Number(l);
    return [Number(i) * width, (Number(i) + 1) * width] as [number, number];
  });
}

beforeEach(() => {
  db = new Database(':memory:');
  new SessionStore(db);
  createMemoryTreeSchema(db);
  promptNumber = 0;
  seedSession();
});

describe('leaves', () => {
  it('numbers observations and prompts together, oldest first, densely', () => {
    addPrompt('first prompt');
    addObservation('first observation');
    addPrompt('second prompt');
    expect(indexNewLeaves(db, PROJECT)).toBe(3);
    expect(leafCount(db, PROJECT)).toBe(3);
    expect(zoomNode(db, PROJECT, 0, 0)?.text).toContain('first prompt');
    expect(zoomNode(db, PROJECT, 0, 1)?.text).toContain('first observation');
    expect(indexNewLeaves(db, PROJECT)).toBe(0);
  });

  it('appends a late row after the ones already numbered, even if it is dated earlier', () => {
    addObservation('a');
    addObservation('b');
    indexNewLeaves(db, PROJECT);
    addObservation('late but dated first', 1);
    indexNewLeaves(db, PROJECT);
    expect(zoomNode(db, PROJECT, 0, 0)?.text).toContain('a');
    expect(zoomNode(db, PROJECT, 0, 2)?.text).toContain('late but dated first');
  });

  it('keeps other projects out', () => {
    db.prepare(`INSERT INTO observations (memory_session_id, project, type, title, created_at, created_at_epoch)
      VALUES ('memory-content-tree', 'other', 'discovery', 'elsewhere', '2026-10-01T00:00:00.000Z', 1)`).run();
    addObservation('here');
    indexNewLeaves(db, PROJECT);
    expect(leafCount(db, PROJECT)).toBe(1);
  });
});

describe('merges', () => {
  it('offers complete pairs only, then their parents once both are built', () => {
    for (const t of ['a', 'b', 'c', 'd', 'e']) addObservation(t);
    indexNewLeaves(db, PROJECT);
    expect(readyMerges(db, PROJECT, 10).map(m => [m.level, m.idx])).toEqual([[1, 0], [1, 1]]);
    const first = readyMerges(db, PROJECT, 10)[0];
    expect(first.older).toContain('a');
    expect(first.newer).toContain('b');
    storeMerge(db, PROJECT, 1, 0, 'ab');
    expect(readyMerges(db, PROJECT, 10).map(m => [m.level, m.idx])).toEqual([[1, 1]]);
    storeMerge(db, PROJECT, 1, 1, 'cd');
    expect(readyMerges(db, PROJECT, 10).map(m => [m.level, m.idx])).toEqual([[2, 0]]);
  });

  it('offers the oldest work first and honours the limit', () => {
    for (let i = 0; i < 8; i++) addObservation(`o${i}`);
    indexNewLeaves(db, PROJECT);
    expect(readyMerges(db, PROJECT, 2).map(m => m.idx)).toEqual([0, 1]);
  });
});

describe('deletion', () => {
  it('drops every summary above a deleted row, and none rebuilt from it carries its text', () => {
    const SECRET = 'AKIAEXAMPLESECRET0000';
    const ids = ['a', 'b', `token ${SECRET}`, 'd', 'e', 'f', 'g', 'h'].map(t => addObservation(t));
    indexNewLeaves(db, PROJECT);
    buildAll((l, i, older, newer) => `L${l}:${i} ${older} ${newer}`.slice(0, 2000));
    const nodesWithSecret = () => (db.prepare('SELECT COUNT(*) AS n FROM memory_nodes WHERE text LIKE ?').get(`%${SECRET}%`) as { n: number }).n;
    expect(nodesWithSecret()).toBeGreaterThan(0);

    db.prepare('DELETE FROM observations WHERE id = ?').run(ids[2]);
    deleteTreeOfRow(db, 'observation', ids[2]);
    expect(nodesWithSecret()).toBe(0);
    // Its ancestors only: (1,1), (2,0), (3,0). The rest stay built.
    expect((db.prepare('SELECT COUNT(*) AS n FROM memory_nodes').get() as { n: number }).n).toBe(7 - 3);

    buildAll((l, i, older, newer) => `L${l}:${i} ${older} ${newer}`.slice(0, 2000));
    expect(nodesWithSecret()).toBe(0);
    expect(zoomNode(db, PROJECT, 0, 2)?.text).not.toContain(SECRET);
  });

  it('handles a deleted prompt the same way', () => {
    const id = addPrompt('private plan');
    addObservation('x');
    indexNewLeaves(db, PROJECT);
    buildAll();
    db.prepare('DELETE FROM user_prompts WHERE id = ?').run(id);
    deleteTreeOfRow(db, 'prompt', id);
    expect((db.prepare('SELECT COUNT(*) AS n FROM memory_nodes').get() as { n: number }).n).toBe(0);
  });
});

describe('view', () => {
  function seedBuilt(n: number): void {
    for (let i = 0; i < n; i++) addObservation(`observation number ${i} with a title of ordinary length`);
    indexNewLeaves(db, PROJECT);
    buildAll((l, i) => `summary of nodes at level ${l} index ${i}, written to be about as long as a real one`);
  }

  for (const n of [1, 2, 7, 1000]) {
    it(`covers every one of ${n} leaves exactly once, within the budget`, () => {
      seedBuilt(n);
      const view = renderTreeView(db, PROJECT, 6000);
      expect(view.length).toBeLessThanOrEqual(6000);
      const ranges = coveredRanges(view);
      let next = 0;
      for (const [from, to] of ranges) {
        expect(from).toBe(next);
        next = to;
      }
      expect(next).toBe(n);
    });
  }

  it('shows the newest work at least as finely as older work', () => {
    seedBuilt(1000);
    const widths = coveredRanges(renderTreeView(db, PROJECT, 6000)).map(([from, to]) => to - from);
    for (let i = 1; i < widths.length; i++) expect(widths[i]).toBeLessThanOrEqual(widths[i - 1]);
    expect(widths.at(-1)).toBe(1);
  });

  it('shows a node not built yet as its children', () => {
    for (const t of ['a', 'b', 'c', 'd']) addObservation(t);
    indexNewLeaves(db, PROJECT);
    storeMerge(db, PROJECT, 1, 0, 'ab');
    const ranges = coveredRanges(renderTreeView(db, PROJECT, 100_000));
    expect(ranges.at(-1)?.[1]).toBe(4);
    expect(renderTreeView(db, PROJECT, 100_000)).not.toContain('[L2:0]');
  });

  it('is empty for a project with no leaves', () => {
    expect(renderTreeView(db, PROJECT, 6000)).toBe('');
  });
});

describe('zoom', () => {
  it('opens a node into its two children, and a leaf into its row', () => {
    for (const t of ['a', 'b', 'c', 'd']) addObservation(t);
    indexNewLeaves(db, PROJECT);
    buildAll();
    const top = zoomNode(db, PROJECT, 2, 0)!;
    expect(coveredRanges(top.text)).toEqual([[0, 2], [2, 4]]);
    const leaf = zoomNode(db, PROJECT, 0, 3)!;
    expect(leaf.text).toContain('narrative of d');
  });

  it('answers null outside the tree', () => {
    addObservation('a');
    indexNewLeaves(db, PROJECT);
    expect(zoomNode(db, PROJECT, 0, 5)).toBeNull();
    expect(zoomNode(db, PROJECT, 3, 0)).toBeNull();
  });
});

describe('parseTreeProjects', () => {
  it('reads off, a list, or every project', () => {
    expect(parseTreeProjects('')('a')).toBe(false);
    expect(parseTreeProjects('a, b')('b')).toBe(true);
    expect(parseTreeProjects('a, b')('c')).toBe(false);
    expect(parseTreeProjects('*')('anything')).toBe(true);
  });
});
