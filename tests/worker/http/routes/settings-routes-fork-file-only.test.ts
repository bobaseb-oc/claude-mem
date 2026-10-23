import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Request, Response } from 'express';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import path from 'path';
import { SettingsRoutes } from '../../../../src/services/worker/http/routes/SettingsRoutes.js';
import { paths } from '../../../../src/shared/paths.js';

function postSettings(body: Record<string, unknown>): { json: ReturnType<typeof mock> } {
  let handler!: (req: Request, res: Response) => void;
  const app: any = {
    get: mock(() => {}),
    post: mock((path: string, ...handlers: Array<(req: Request, res: Response) => void>) => {
      if (path === '/api/settings') handler = handlers[handlers.length - 1];
    }),
  };
  new SettingsRoutes({} as any).setupRoutes(app);
  const json = mock(() => {});
  const status = mock(() => ({ json }));
  const res = { json, status, headersSent: false } as unknown as Response;
  handler({ body, path: '/api/settings', params: {}, query: {}, headers: {} } as Request, res);
  return { json };
}

// Fork hardening H2 (tasks/security-review.md): POST /api/settings has no
// auth, and an Origin-less client (curl, an agent's Bash) passes the browser
// origin check. Each key below would let such a client run code outside the
// sandbox (a data dir holding its own settings.json and grammar libraries, a
// config dir), send transcripts and keys elsewhere (base URLs, providers,
// presets), open the API to the LAN (worker host), or write CLAUDE.md files.
// So they are file/env only, like the spawn paths.
const ATTACKER_VALUES: Record<string, string> = {
  CLAUDE_MEM_DATA_DIR: '/tmp/attacker-data-dir',
  CLAUDE_MEM_CLAUDE_CONFIG_DIR: '/tmp/attacker-config-dir',
  CLAUDE_MEM_OBSERVER_CLAUDE_CONFIG_DIR: '/tmp/attacker-observer-dir',
  CLAUDE_MEM_OPENROUTER_BASE_URL: 'https://attacker.example/api/v1',
  CLAUDE_MEM_OPENAI_COMPAT_BASE_URL: 'https://attacker.example/v1',
  CLAUDE_MEM_OPENAI_COMPAT_PRESET: 'nvidia-nim',
  CLAUDE_MEM_PROVIDER: 'openai-compatible',
  CLAUDE_MEM_QUOTA_FALLBACK_PROVIDER: 'openrouter',
  CLAUDE_MEM_WORKER_HOST: '0.0.0.0',
  CLAUDE_MEM_FOLDER_CLAUDEMD_ENABLED: 'true',
};

describe('SettingsRoutes — destination and path settings are not HTTP-writable (H2)', () => {
  const settingsPath = paths.settings();
  let prior: string | undefined;

  beforeEach(() => {
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    prior = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf-8') : undefined;
  });

  afterEach(() => {
    if (prior === undefined) rmSync(settingsPath, { force: true });
    else writeFileSync(settingsPath, prior, 'utf-8');
  });

  for (const [key, value] of Object.entries(ATTACKER_VALUES)) {
    it(`does not persist ${key} from POST /api/settings`, () => {
      writeFileSync(settingsPath, JSON.stringify({}));
      const { json } = postSettings({ [key]: value, CLAUDE_MEM_LOG_LEVEL: 'DEBUG' });
      expect(json).toHaveBeenCalledWith({ success: true, message: 'Settings updated successfully' });
      const persisted = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect({ key, value: persisted[key] }).toEqual({ key, value: undefined });
      expect(persisted.CLAUDE_MEM_LOG_LEVEL).toBe('DEBUG');
    });

    it(`keeps a file-configured ${key} when a POST sends another`, () => {
      writeFileSync(settingsPath, JSON.stringify({ [key]: 'file-value' }));
      postSettings({ [key]: value, CLAUDE_MEM_LOG_LEVEL: 'DEBUG' });
      const persisted = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect({ key, value: persisted[key] }).toEqual({ key, value: 'file-value' });
    });
  }

  it('still saves an ordinary setting (the viewer keeps working)', () => {
    writeFileSync(settingsPath, JSON.stringify({}));
    postSettings({ CLAUDE_MEM_CONTEXT_OBSERVATIONS: '42' });
    expect(JSON.parse(readFileSync(settingsPath, 'utf-8')).CLAUDE_MEM_CONTEXT_OBSERVATIONS).toBe('42');
  });
});
