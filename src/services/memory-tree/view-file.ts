/**
 * Fork Phase 2 (2f): the tree as a file a repo's CLAUDE.local.md can import
 * (`@~/.claude-mem/views/<name>.md`). Memory files load whole at session
 * start (up to 4 MiB), where hook output stops at 10,000 chars. The worker
 * rewrites the file after a build pass, so it is current whenever a session
 * starts: written to a temporary file and renamed into place (a reader never
 * sees half of one), 0600 in a 0700 directory. Off unless
 * CLAUDE_MEM_TREE_FILE_BYTES is set.
 */
import { Database } from 'bun:sqlite';
import { createHash } from 'crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { treeContextSection } from './context-section.js';

/** The file for a project: a readable, filesystem-safe name plus a short hash, so distinct projects never collide. */
export function viewFilePath(directory: string, project: string): string {
  const readable = project.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '').slice(0, 80) || 'project';
  const hash = createHash('sha256').update(project).digest('hex').slice(0, 8);
  return join(directory, `${readable}-${hash}.md`);
}

/**
 * Whether a CLAUDE.local.md at `cwd` or a directory above it imports this
 * project's view file, and that file is written, so the session loads the tree
 * from it and the SessionStart hook can leave its own section out there (and
 * only there). Until the first build pass writes the file, the hook shows it.
 */
export function viewFileImported(cwd: string, directory: string, project: string): boolean {
  const viewFile = viewFilePath(directory, project);
  if (!existsSync(viewFile)) return false;
  const name = basename(viewFile);
  let current = resolve(cwd);
  for (let depth = 0; depth < 12; depth++) {
    const file = join(current, 'CLAUDE.local.md');
    if (existsSync(file) && readFileSync(file, 'utf-8').includes(name)) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
  return false;
}

/** Rewrites the project's view file within `maxBytes`. Returns its path, or null when off or empty. */
export function writeViewFile(db: Database, project: string, directory: string, maxBytes: number): string | null {
  if (!(maxBytes > 0)) return null;
  // Characters, then bytes: lines are mostly ASCII, so shrink only if needed.
  let budget = maxBytes;
  let text = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    text = treeContextSection(db, project, { projects: '*', viewChars: budget });
    if (Buffer.byteLength(text) <= maxBytes) break;
    budget = Math.floor(budget * maxBytes / Buffer.byteLength(text)) - 64;
  }
  if (!text || Buffer.byteLength(text) > maxBytes) return null;

  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = viewFilePath(directory, project);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, text, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  return path;
}
