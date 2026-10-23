import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Request, Response } from 'express';
import { SessionStore } from '../../../../src/services/sqlite/SessionStore.js';
import { CloudSync } from '../../../../src/services/sync/CloudSync.js';
import { DataRoutes } from '../../../../src/services/worker/http/routes/DataRoutes.js';

// Fork hardening H5 (tasks/security-review.md): deleting one observation or
// one prompt also deletes the raw tool I/O behind it (tool_uses), which
// get_tool_uses and /api/tool-uses would otherwise still return. Only a whole
// session delete did that before.

const SECRET = 'AKIAEXAMPLESECRET0000';

function seed(db: Database): { observationId: number; promptId: number } {
  db.prepare(`
    INSERT INTO sdk_sessions
      (content_session_id, memory_session_id, project, platform_source, started_at, started_at_epoch, status)
    VALUES ('content-h5', 'memory-h5', 'proj-h5', 'claude', '2026-07-20T00:00:00.000Z', 1752969600000, 'completed')
  `).run();
  const sessionDbId = (db.prepare(`SELECT id FROM sdk_sessions WHERE content_session_id = 'content-h5'`).get() as { id: number }).id;
  const insertObservation = db.prepare(`
    INSERT INTO observations (memory_session_id, project, type, title, created_at, created_at_epoch)
    VALUES ('memory-h5', 'proj-h5', 'discovery', ?, '2026-07-20T00:00:00.000Z', 1752969600000)
  `);
  const observationId = Number(insertObservation.run('the one deleted').lastInsertRowid);
  const keptObservationId = Number(insertObservation.run('kept').lastInsertRowid);
  const insertPrompt = db.prepare(`
    INSERT INTO user_prompts (session_db_id, content_session_id, prompt_number, prompt_text, created_at, created_at_epoch)
    VALUES (?, 'content-h5', ?, ?, '2026-07-20T00:00:00.000Z', 1752969600000)
  `);
  const promptId = Number(insertPrompt.run(sessionDbId, 1, 'the one deleted').lastInsertRowid);
  insertPrompt.run(sessionDbId, 2, 'kept');
  const insertToolUse = db.prepare(`
    INSERT INTO tool_uses (tool_use_id, content_session_id, session_db_id, project, platform_source, tool_name,
                           tool_input, prompt_number, observation_id, created_at, created_at_epoch)
    VALUES (?, 'content-h5', ?, 'proj-h5', 'claude', 'Bash', ?, ?, ?, '2026-07-20T00:00:00.000Z', 1752969600000)
  `);
  insertToolUse.run('of-observation', sessionDbId, `{"command":"echo ${SECRET}"}`, 2, observationId);
  insertToolUse.run('of-prompt', sessionDbId, `{"command":"echo ${SECRET}"}`, 1, null);
  insertToolUse.run('unrelated', sessionDbId, '{"command":"ls"}', 2, keptObservationId);
  return { observationId, promptId };
}

const toolUseIds = (db: Database) =>
  (db.prepare('SELECT tool_use_id FROM tool_uses ORDER BY tool_use_id').all() as Array<{ tool_use_id: string }>).map(r => r.tool_use_id);

describe.each([
  ['without cloud sync', false],
  ['with cloud sync (delete queued)', true],
])('row delete drops its tool I/O (H5), %s', (_label, withSync) => {
  let db: Database;
  let tempDir: string;
  let store: SessionStore;
  let sync: CloudSync;
  let handlers: Map<string, (req: Request, res: Response) => void>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'cmem-row-delete-h5-'));
    db = new Database(':memory:');
    store = new SessionStore(db);
    sync = new CloudSync(db, {
      CLAUDE_MEM_CLOUD_SYNC_TOKEN: 'test-token',
      CLAUDE_MEM_CLOUD_SYNC_USER_ID: 'test-user',
      CLAUDE_MEM_CLOUD_SYNC_HUB_URL: 'https://hub.test',
      CLAUDE_MEM_CLOUD_SYNC_DEVICE_ID: 'device-h5',
      CLAUDE_MEM_CLOUD_SYNC_DEVICE_NAME: 'test',
    }, {
      settingsPath: join(tempDir, 'settings.json'),
      fetchImpl: mock(async () => new Response('{}', { status: 500 })) as typeof fetch,
    });
    const routes = new DataRoutes(
      {} as any,
      { getSessionStore: () => store, getCloudSync: () => (withSync ? sync : null), getChromaSync: () => null } as any,
      { getSession: () => undefined } as any,
      { broadcast: () => {} } as any,
      {} as any,
      Date.now(),
    );
    handlers = new Map();
    routes.setupRoutes({
      get: mock(() => {}),
      post: mock(() => {}),
      delete: mock((path: string, handler: (req: Request, res: Response) => void) => { handlers.set(path, handler); }),
    } as any);
  });

  afterEach(() => {
    sync.stop();
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function callDelete(path: string, id: number): number {
    let status = 200;
    const response = {
      status(code: number) { status = code; return this; },
      json() { return this; },
    } as unknown as Response;
    handlers.get(path)!({ params: { id: String(id) }, query: {}, path, get: () => undefined } as unknown as Request, response);
    return status;
  }

  it('deleting an observation deletes the tool uses linked to it, and nothing else', () => {
    const { observationId } = seed(db);
    expect(callDelete('/api/observation/:id', observationId)).toBe(200);
    expect(toolUseIds(db)).toEqual(['of-prompt', 'unrelated']);
  });

  it("deleting a prompt deletes its turn's tool uses, and nothing else", () => {
    const { promptId } = seed(db);
    expect(callDelete('/api/prompt/:id', promptId)).toBe(200);
    expect(toolUseIds(db)).toEqual(['of-observation', 'unrelated']);
  });

  it('leaves no copy of the secret once both are deleted', () => {
    const { observationId, promptId } = seed(db);
    callDelete('/api/observation/:id', observationId);
    callDelete('/api/prompt/:id', promptId);
    const rows = db.prepare('SELECT tool_input FROM tool_uses').all() as Array<{ tool_input: string }>;
    expect(rows.some(row => row.tool_input.includes(SECRET))).toBe(false);
  });
});
