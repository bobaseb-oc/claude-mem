import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { HookSpool, HOOK_SPOOL_RETIRED_RETENTION_MS } from '../../src/shared/hook-spool.js';
import { SettingsDefaultsManager } from '../../src/shared/SettingsDefaultsManager.js';
import { _resetRedactionConfigCache } from '../../src/utils/redaction.js';

// Fork hardening H4 (tasks/security-review.md): the spool holds raw tool I/O
// until the worker ingests it, and entries it gives up on are kept in
// expired/ and corrupt/. So what is written is already stripped of memory tags
// and redacted, only the user can read it, and retired entries are deleted
// once they are a week old.
const OPENAI_KEY = 'sk-ABCDEFGHIJ1234567890abcdef';

describe('hook spool hardening (H4)', () => {
  let directory: string;
  let loadSpy: ReturnType<typeof spyOn> | undefined;

  function useRedaction(enabled: boolean): void {
    loadSpy?.mockRestore();
    loadSpy = spyOn(SettingsDefaultsManager, 'loadFromFile').mockImplementation(() => ({
      ...SettingsDefaultsManager.getAllDefaults(),
      CLAUDE_MEM_REDACT_ENABLED: enabled ? 'true' : 'false',
    }));
    _resetRedactionConfigCache();
  }

  beforeEach(() => {
    directory = join(mkdtempSync(join(tmpdir(), 'hook-spool-h4-')), 'hook-spool');
    useRedaction(true);
  });

  afterEach(() => {
    loadSpy?.mockRestore();
    loadSpy = undefined;
    _resetRedactionConfigCache();
    rmSync(join(directory, '..'), { recursive: true, force: true });
  });

  function enqueueObservation(spool: HookSpool): string {
    return spool.enqueue('observation', {
      contentSessionId: 'session-h4',
      platformSource: 'claude',
      toolName: 'Bash',
      toolInput: { command: `curl -H "Authorization: Bearer ${OPENAI_KEY}" https://api` },
      toolResponse: { stdout: 'before <private>do-not-store-this</private> after', nested: [`key=${OPENAI_KEY}`] },
      cwd: '/tmp/project',
      toolUseId: 'toolu_h4',
    } as any);
  }

  it('writes tool I/O stripped of memory tags and redacted', () => {
    const entryPath = enqueueObservation(new HookSpool(directory));
    const onDisk = readFileSync(entryPath, 'utf-8');
    expect(onDisk).not.toContain('do-not-store-this');
    expect(onDisk).not.toContain(OPENAI_KEY);
    const { payload } = JSON.parse(onDisk);
    expect(payload.toolResponse.stdout).toBe('before  after');
    expect(payload.toolInput.command).toContain("<redacted type='openai_key'/>");
    expect(payload.contentSessionId).toBe('session-h4');
  });

  it('still strips memory tags while redaction is off', () => {
    useRedaction(false);
    const onDisk = readFileSync(enqueueObservation(new HookSpool(directory)), 'utf-8');
    expect(onDisk).not.toContain('do-not-store-this');
  });

  it.skipIf(process.platform === 'win32')('makes entries 0600 and the spool directory 0700', () => {
    const entryPath = enqueueObservation(new HookSpool(directory));
    expect(statSync(entryPath).mode & 0o777).toBe(0o600);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
  });

  it('deletes retired entries a week old, and keeps newer ones', async () => {
    const spool = new HookSpool(directory);
    const old = Date.now() - HOOK_SPOOL_RETIRED_RETENTION_MS - 60_000;
    for (const retired of [spool.expiredDirectory, spool.corruptDirectory]) {
      mkdirSync(retired, { recursive: true });
      writeFileSync(join(retired, 'old.json'), '{}');
      utimesSync(join(retired, 'old.json'), old / 1000, old / 1000);
      writeFileSync(join(retired, 'recent.json'), '{}');
    }

    await spool.drain(() => true);

    for (const retired of [spool.expiredDirectory, spool.corruptDirectory]) {
      expect(readdirSync(retired).sort()).toEqual(['recent.json']);
    }
  });

  it('is a week of retention', () => {
    expect(HOOK_SPOOL_RETIRED_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(existsSync(directory)).toBe(false);
  });
});
