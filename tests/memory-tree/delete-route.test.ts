import { describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Request, Response } from 'express';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { DataRoutes } from '../../src/services/worker/http/routes/DataRoutes.js';
import { indexNewLeaves, readyMerges, storeMerge } from '../../src/services/memory-tree/MemoryTree.js';

// Fork Phase 2: deleting an observation through the API also drops every tree
// summary above it, so no summary keeps what the observation said.
describe('DELETE /api/observation/:id and the memory tree', () => {
  it('drops the summaries above the deleted observation', () => {
    const db = new Database(':memory:');
    const store = new SessionStore(db);
    db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch, status)
      VALUES ('c', 'm', 'p', 'claude', '2026-10-01T00:00:00.000Z', 1, 'completed')`).run();
    const insert = db.prepare(`INSERT INTO observations (memory_session_id, project, type, title, created_at, created_at_epoch)
      VALUES ('m', 'p', 'discovery', ?, '2026-10-01T00:00:00.000Z', ?)`);
    const ids = ['a', 'secret b', 'c', 'd'].map((t, i) => Number(insert.run(t, i + 1).lastInsertRowid));
    indexNewLeaves(db, 'p');
    for (;;) {
      const ready = readyMerges(db, 'p', 10);
      if (!ready.length) break;
      for (const m of ready) storeMerge(db, 'p', m.level, m.idx, `${m.older} ${m.newer}`);
    }
    const countWithSecret = () => (db.prepare(`SELECT COUNT(*) AS n FROM memory_nodes WHERE text LIKE '%secret%'`).get() as { n: number }).n;
    expect(countWithSecret()).toBe(2);

    const handlers = new Map<string, (req: Request, res: Response) => void>();
    new DataRoutes({} as any, { getSessionStore: () => store, getCloudSync: () => null, getChromaSync: () => null } as any,
      { getSession: () => undefined } as any, { broadcast: () => {} } as any, {} as any, Date.now())
      .setupRoutes({ get: mock(() => {}), post: mock(() => {}), delete: mock((p: string, h: any) => handlers.set(p, h)) } as any);
    let status = 200;
    handlers.get('/api/observation/:id')!(
      { params: { id: String(ids[1]) }, query: {}, path: '/api/observation', get: () => undefined } as unknown as Request,
      { status(c: number) { status = c; return this; }, json() { return this; } } as unknown as Response,
    );

    expect(status).toBe(200);
    expect(countWithSecret()).toBe(0);
    expect((db.prepare('SELECT level, idx FROM memory_nodes ORDER BY level, idx').all())).toEqual([{ level: 1, idx: 1 }]);
  });
});
