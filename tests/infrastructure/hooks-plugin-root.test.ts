import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

// Fork hardening H1 (tasks/security-review.md): every Claude Code runtime hook
// runs the plugin's own launcher by absolute path, never a `claude-mem` looked
// up on PATH, and Bun starts in the plugin's scripts directory so the project
// a hook fires in can't feed it a bunfig.toml preload or a .env. No hook
// compiles a launcher onto PATH or edits a shell rc file (ensure-launcher).

const pluginRoot = path.resolve(import.meta.dir, '../../plugin');
const hooksJsonPath = path.join(pluginRoot, 'hooks/hooks.json');
const LAUNCHER_PREFIX = [
  '--cwd',
  '${CLAUDE_PLUGIN_ROOT}/scripts',
  '${CLAUDE_PLUGIN_ROOT}/scripts/claude-mem-launcher.cjs',
];

type Entry = { command?: string; args?: string[] };

function runtimeEntries(): Array<{ location: string; entry: Entry }> {
  const parsed = JSON.parse(readFileSync(hooksJsonPath, 'utf-8')) as {
    hooks: Record<string, Array<{ hooks: Entry[] }>>;
  };
  return Object.entries(parsed.hooks)
    .filter(([event]) => event !== 'Setup')
    .flatMap(([event, groups]) => groups.flatMap((group, g) =>
      group.hooks.map((entry, h) => ({ location: `${event}.${g}.${h}`, entry }))));
}

// Runs a hook entry the way Claude Code does (exec form, cwd = the project),
// with the plugin root substituted, and says whether the project's preload ran.
function preloadRunsFor(args: string[]): boolean {
  const project = mkdtempSync(path.join(tmpdir(), 'cm-h1-'));
  try {
    const marker = path.join(project, 'PRELOAD_RAN');
    writeFileSync(path.join(project, 'evil.js'), `require('fs').writeFileSync(${JSON.stringify(marker)}, '1')\n`);
    writeFileSync(path.join(project, 'bunfig.toml'), 'preload = ["./evil.js"]\n');
    const resolved = args.map((arg) => arg.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot));
    const run = spawnSync('bun', resolved, { cwd: project, encoding: 'utf-8', timeout: 30_000 });
    expect(run.status).toBe(0);
    return existsSync(marker);
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
}

describe('hooks run the plugin launcher by absolute path (H1)', () => {
  const entries = runtimeEntries();

  it('has runtime entries to check', () => {
    expect(entries.length).toBeGreaterThanOrEqual(8);
  });

  for (const { location, entry } of entries) {
    it(`${location} runs bun --cwd <plugin scripts> <plugin launcher>`, () => {
      expect({ location, command: entry.command }).toEqual({ location, command: 'bun' });
      expect({ location, prefix: entry.args?.slice(0, 3) }).toEqual({ location, prefix: LAUNCHER_PREFIX });
    });
  }

  it('has no ensure-launcher hook (no PATH binary, no rc edit)', () => {
    expect(readFileSync(hooksJsonPath, 'utf-8')).not.toContain('ensure-launcher');
  });

  it("a project's bunfig.toml preload does not run", () => {
    const args = [...entries[0].entry.args!.slice(0, 3), '--version'];
    expect(preloadRunsFor(args)).toBe(false);
  });

  it('control: without --cwd the same preload does run', () => {
    const args = [LAUNCHER_PREFIX[2], '--version'];
    expect(preloadRunsFor(args)).toBe(true);
  });
});
