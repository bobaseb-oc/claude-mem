import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Request, Response } from 'express';
import { SessionStore } from '../../src/services/sqlite/SessionStore.js';
import { indexNewLeaves, readyMerges, storeMerge } from '../../src/services/memory-tree/MemoryTree.js';
import { MemoryTreeRoutes } from '../../src/services/worker/http/routes/MemoryTreeRoutes.js';

// Fork Phase 2: memory_zoom reads GET /api/memory-tree/zoom as text; status
// says how far a project's tree is built.
let db: Database;
let handlers: Map<string, (req: Request, res: Response) => void>;

function call(path: string, query: Record<string, string>): { status: number; body: unknown; type?: string } {
  const out: { status: number; body: unknown; type?: string } = { status: 200, body: undefined };
  const res = {
    status(code: number) { out.status = code; return this; },
    type(t: string) { out.type = t; return this; },
    send(body: unknown) { out.body = body; return this; },
    json(body: unknown) { out.body = body; return this; },
  } as unknown as Response;
  handlers.get(path)!({ query, params: {}, path } as unknown as Request, res);
  return out;
}

beforeEach(() => {
  db = new Database(':memory:');
  const store = new SessionStore(db);
  db.prepare(`INSERT INTO sdk_sessions (content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch, status)
    VALUES ('c', 'm', 'p', 'claude', '2026-10-01T00:00:00.000Z', 1, 'active')`).run();
  const insert = db.prepare(`INSERT INTO observations (memory_session_id, project, type, title, narrative, created_at, created_at_epoch)
    VALUES ('m', 'p', 'discovery', ?, ?, '2026-10-01T00:00:00.000Z', ?)`);
  for (const [i, t] of ['a', 'b', 'c', 'd'].entries()) insert.run(t, `story of ${t}`, i + 1);
  indexNewLeaves(db, 'p');
  for (const m of readyMerges(db, 'p', 10)) storeMerge(db, 'p', m.level, m.idx, `pair ${m.idx}`);
  handlers = new Map();
  new MemoryTreeRoutes({ getSessionStore: () => store } as any)
    .setupRoutes({ get: mock((p: string, h: any) => handlers.set(p, h)), post: mock(() => {}) } as any);
});

describe('MemoryTreeRoutes', () => {
  it('zooms a node into its halves, as text', () => {
    const r = call('/api/memory-tree/zoom', { project: 'p', level: '1', idx: '1' });
    expect(r.status).toBe(200);
    expect(r.type).toBe('text/plain');
    expect(String(r.body)).toContain('[L0:2]');
    expect(String(r.body)).toContain('[L0:3]');
  });

  it('zooms a leaf into its row', () => {
    expect(String(call('/api/memory-tree/zoom', { project: 'p', level: '0', idx: '0' }).body)).toContain('story of a');
  });

  it('answers 404 outside the tree and 400 on bad input', () => {
    expect(call('/api/memory-tree/zoom', { project: 'p', level: '5', idx: '0' }).status).toBe(404);
    expect(call('/api/memory-tree/zoom', { project: 'p', level: 'x', idx: '0' }).status).toBe(400);
    expect(call('/api/memory-tree/zoom', { level: '0', idx: '0' }).status).toBe(400);
  });

  it('reports how far the tree is built', () => {
    expect(call('/api/memory-tree/status', { project: 'p' }).body).toEqual({ project: 'p', leaves: 4, nodes: 2, ready: 1 });
  });
});
