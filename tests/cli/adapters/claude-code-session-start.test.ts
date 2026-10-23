import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { claudeCodeAdapter } from '../../../src/cli/adapters/claude-code.js';
import { CLAUDE_MEM_LAUNCHER_ARGS } from '../../../src/build/hook-shell-template.js';

const baseInput = {
  hook_event_name: 'SessionStart',
  session_id: 'session-start-source',
  cwd: process.cwd(),
};

describe('Claude Code SessionStart source', () => {
  for (const source of ['startup', 'resume', 'clear', 'compact']) {
    it(`preserves ${source} when normalizing the hook input`, () => {
      expect(claudeCodeAdapter.normalizeInput({ ...baseInput, source }).sessionSource).toBe(source);
    });
  }

  it('drops missing, unknown, and non-string sources', () => {
    for (const source of [undefined, null, '', 'archive', 42, { source: 'resume' }]) {
      expect(claudeCodeAdapter.normalizeInput({ ...baseInput, source }).sessionSource).toBeUndefined();
    }
  });
});

interface SessionStartGroup {
  matcher?: string;
  hooks: Array<{ command: string; args?: string[] }>;
}

const { hooks } = JSON.parse(readFileSync(
  new URL('../../../plugin/hooks/hooks.json', import.meta.url),
  'utf-8',
)) as { hooks: { SessionStart: SessionStartGroup[] } };

function commandsForSource(source: string): string[] {
  return hooks.SessionStart
    .filter(group => !group.matcher || new RegExp(group.matcher).test(source))
    // Named as the launcher's subcommand: the entry is `bun <launcher> <args>` (fork hardening H1).
    .flatMap(group => group.hooks.map(hook => ['claude-mem', ...(hook.args ?? []).slice(CLAUDE_MEM_LAUNCHER_ARGS.length)].join(' ')));
}

describe('Claude Code SessionStart hook matchers', () => {
  it('starts the worker on resume without running timeline injection', () => {
    const commands = commandsForSource('resume');
    expect(commands.filter(command => command === 'claude-mem start')).toHaveLength(1);
    expect(commands.filter(command => command === 'claude-mem hook claude-code context')).toHaveLength(0);
  });

  for (const source of ['startup', 'clear', 'compact']) {
    it(`keeps timeline injection and worker startup on ${source}`, () => {
      const commands = commandsForSource(source);
      expect(commands.filter(command => command === 'claude-mem start')).toHaveLength(1);
      expect(commands.filter(command => command === 'claude-mem hook claude-code context')).toHaveLength(1);
    });
  }
});
