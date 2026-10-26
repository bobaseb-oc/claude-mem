import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { viewFileImported, viewFilePath } from '../../src/services/memory-tree/view-file.js';

// Fork Phase 2: the SessionStart hook leaves its tree section out only where
// the repo's CLAUDE.local.md imports that project's view file, so a repo
// without the import still sees the tree.
let repo: string;
const views = '/home/x/.claude-mem/views';

beforeEach(() => { repo = mkdtempSync(join(tmpdir(), 'tree-import-')); mkdirSync(join(repo, 'src', 'deep'), { recursive: true }); });
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe('viewFileImported', () => {
  it('finds the import in CLAUDE.local.md at the cwd or above it', () => {
    writeFileSync(join(repo, 'CLAUDE.local.md'), `# tree\n@~/.claude-mem/views/${basename(viewFilePath(views, 'p'))}\n`);
    expect(viewFileImported(join(repo, 'src', 'deep'), views, 'p')).toBe(true);
    expect(viewFileImported(repo, views, 'p')).toBe(true);
  });

  it("is false without the file, or when it imports another project's view", () => {
    expect(viewFileImported(repo, views, 'p')).toBe(false);
    writeFileSync(join(repo, 'CLAUDE.local.md'), `@~/.claude-mem/views/${basename(viewFilePath(views, 'other'))}\n`);
    expect(viewFileImported(repo, views, 'p')).toBe(false);
  });
});
