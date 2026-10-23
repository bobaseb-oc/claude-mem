/**
 * Fork Phase 2: the memory tree (tasks/todo.md).
 *
 * A project's observations and prompts are the leaves of a binary tree,
 * numbered in the order the tree first sees them (append-only, so a late row
 * never shifts the ones before it). Node (l, i), l >= 1, is a one-line summary
 * of nodes (l-1, 2i) and (l-1, 2i+1); level 0 is the leaves themselves. Leaf
 * text is always read from its row, never copied, so deleting the row deletes
 * it; deleting also drops every node above it (deleteTreeOfRow), which is then
 * rebuilt without it.
 *
 * The tables are a cache: everything here can be rebuilt from observations and
 * user_prompts, so the DDL is idempotent and stamps no schema version (an
 * older build keeps opening the database).
 */
import type { Database } from 'bun:sqlite';

export type LeafKind = 'observation' | 'prompt';

interface Leaf { kind: LeafKind; rowId: number; epoch: number }

export interface ReadyMerge { level: number; idx: number; older: string; newer: string }

const NODE_LINE_CHARS = 300;
const LEAF_LINE_CHARS = 200;
const MAX_LEVEL = 40;

export function createMemoryTreeSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS memory_leaves (
    project TEXT NOT NULL,
    idx INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('observation', 'prompt')),
    row_id INTEGER NOT NULL,
    created_at_epoch INTEGER NOT NULL,
    PRIMARY KEY (project, idx),
    UNIQUE (kind, row_id)
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS memory_nodes (
    project TEXT NOT NULL,
    level INTEGER NOT NULL CHECK (level >= 1),
    idx INTEGER NOT NULL,
    text TEXT NOT NULL,
    built_at_epoch INTEGER NOT NULL,
    PRIMARY KEY (project, level, idx)
  )`);
}

/** '' = no project, '*' = every project, else a comma-separated list. */
export function parseTreeProjects(setting: string | undefined): (project: string) => boolean {
  const value = (setting ?? '').trim();
  if (value === '*') return () => true;
  const names = new Set(value.split(',').map(name => name.trim()).filter(Boolean));
  return project => names.has(project);
}

/** Numbers the project's rows the tree has not seen yet, after the ones it has. Returns how many. */
export function indexNewLeaves(db: Database, project: string): number {
  return db.transaction(() => {
    const unseen = db.prepare(`
      SELECT 'observation' AS kind, o.id AS row_id, o.created_at_epoch AS epoch
        FROM observations o
       WHERE o.project = ?
         AND NOT EXISTS (SELECT 1 FROM memory_leaves l WHERE l.kind = 'observation' AND l.row_id = o.id)
      UNION ALL
      SELECT 'prompt', up.id, up.created_at_epoch
        FROM user_prompts up
        JOIN sdk_sessions s ON s.id = up.session_db_id
          OR (up.session_db_id IS NULL AND s.content_session_id = up.content_session_id)
       WHERE s.project = ?
         AND NOT EXISTS (SELECT 1 FROM memory_leaves l WHERE l.kind = 'prompt' AND l.row_id = up.id)
      ORDER BY epoch, kind, row_id
    `).all(project, project) as Array<{ kind: LeafKind; row_id: number; epoch: number }>;
    let next = leafCount(db, project);
    const insert = db.prepare(`INSERT OR IGNORE INTO memory_leaves (project, idx, kind, row_id, created_at_epoch)
      VALUES (?, ?, ?, ?, ?)`);
    let added = 0;
    for (const row of unseen) {
      if (insert.run(project, next, row.kind, row.row_id, row.epoch).changes > 0) { next++; added++; }
    }
    return added;
  }).immediate();
}

export function leafCount(db: Database, project: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM memory_leaves WHERE project = ?').get(project) as { n: number }).n;
}

function loadLeaves(db: Database, project: string): Leaf[] {
  return (db.prepare('SELECT kind, row_id, created_at_epoch FROM memory_leaves WHERE project = ? ORDER BY idx')
    .all(project) as Array<{ kind: LeafKind; row_id: number; created_at_epoch: number }>)
    .map(row => ({ kind: row.kind, rowId: row.row_id, epoch: row.created_at_epoch }));
}

function loadNodes(db: Database, project: string): Map<string, string> {
  const nodes = new Map<string, string>();
  for (const row of db.prepare('SELECT level, idx, text FROM memory_nodes WHERE project = ?').all(project) as Array<{ level: number; idx: number; text: string }>) {
    nodes.set(`${row.level}:${row.idx}`, row.text);
  }
  return nodes;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** A leaf's text from its row: one line, or (full) everything worth reading. Null once the row is gone. */
function leafText(db: Database, leaf: Leaf, full: boolean): string | null {
  if (leaf.kind === 'observation') {
    const row = db.prepare('SELECT id, title, subtitle, narrative, facts FROM observations WHERE id = ?').get(leaf.rowId) as
      { id: number; title: string | null; subtitle: string | null; narrative: string | null; facts: string | null } | null;
    if (!row) return null;
    const title = [row.title, row.subtitle].filter(Boolean).join(': ') || '(untitled observation)';
    if (!full) return oneLine(title, LEAF_LINE_CHARS);
    return [`observation #${row.id}: ${title}`, row.narrative, row.facts].filter(Boolean).join('\n');
  }
  const row = db.prepare('SELECT prompt_text FROM user_prompts WHERE id = ?').get(leaf.rowId) as { prompt_text: string } | null;
  if (!row) return null;
  return full ? `prompt: ${row.prompt_text}` : oneLine(`prompt: ${row.prompt_text}`, LEAF_LINE_CHARS);
}

function day(epoch: number): string {
  return new Date(epoch).toISOString().slice(0, 10);
}

/** The view line of part (level, idx): its id, its dates, its text. */
function partLine(db: Database, leaves: Leaf[], nodes: Map<string, string>, level: number, idx: number): string {
  const first = leaves[idx * 2 ** level];
  const last = leaves[(idx + 1) * 2 ** level - 1];
  const dates = first.epoch === last.epoch || day(first.epoch) === day(last.epoch) ? day(first.epoch) : `${day(first.epoch)}…${day(last.epoch)}`;
  const text = level === 0
    ? (leafText(db, first, false) ?? '(deleted)')
    : oneLine(nodes.get(`${level}:${idx}`) ?? '', NODE_LINE_CHARS);
  return `- [L${level}:${idx}] ${dates} ${text}`;
}

/** Nodes whose two halves are ready and that are not built yet, lowest level first, oldest first. */
export function readyMerges(db: Database, project: string, limit: number): ReadyMerge[] {
  const leaves = loadLeaves(db, project);
  const nodes = loadNodes(db, project);
  const childText = (level: number, idx: number): string => level === 0
    ? (leafText(db, leaves[idx], true) ?? '(deleted)')
    : nodes.get(`${level}:${idx}`) ?? '';
  const ready: ReadyMerge[] = [];
  for (let level = 1; level <= MAX_LEVEL && 2 ** level <= leaves.length; level++) {
    const complete = Math.floor(leaves.length / 2 ** level);
    for (let idx = 0; idx < complete; idx++) {
      if (nodes.has(`${level}:${idx}`)) continue;
      if (level > 1 && !(nodes.has(`${level - 1}:${2 * idx}`) && nodes.has(`${level - 1}:${2 * idx + 1}`))) continue;
      ready.push({ level, idx, older: childText(level - 1, 2 * idx), newer: childText(level - 1, 2 * idx + 1) });
      if (ready.length >= limit) return ready;
    }
  }
  return ready;
}

export function storeMerge(db: Database, project: string, level: number, idx: number, text: string): void {
  db.prepare(`INSERT OR REPLACE INTO memory_nodes (project, level, idx, text, built_at_epoch) VALUES (?, ?, ?, ?, ?)`)
    .run(project, level, idx, oneLine(text, NODE_LINE_CHARS), Date.now());
}

/** Drops every node above the leaf of this row, so none keeps what the row said. Returns how many. */
export function deleteTreeOfRow(db: Database, kind: LeafKind, rowId: number | string): number {
  const leaf = db.prepare('SELECT project, idx FROM memory_leaves WHERE kind = ? AND row_id = ?').get(kind, Number(rowId)) as
    { project: string; idx: number } | null;
  if (!leaf) return 0;
  const drop = db.prepare('DELETE FROM memory_nodes WHERE project = ? AND level = ? AND idx = ?');
  let dropped = 0;
  for (let level = 1; level <= MAX_LEVEL; level++) dropped += drop.run(leaf.project, level, leaf.idx >> level).changes;
  return dropped;
}

type Part = { level: number; idx: number };

/**
 * The whole history in at most `budgetChars`: the fewest built nodes covering
 * every leaf (a node not built yet shows as its halves), then, while the
 * budget allows, the newest node that can be split without leaving it coarser
 * than what follows is split into its halves. Detail fades with age.
 */
export function renderTreeView(db: Database, project: string, budgetChars: number): string {
  const leaves = loadLeaves(db, project);
  if (leaves.length === 0) return '';
  const nodes = loadNodes(db, project);
  const lineCache = new Map<string, string>();
  const line = (p: Part) => {
    const key = `${p.level}:${p.idx}`;
    let cached = lineCache.get(key);
    if (cached === undefined) lineCache.set(key, cached = partLine(db, leaves, nodes, p.level, p.idx));
    return cached;
  };
  const expand = (p: Part): Part[] => p.level === 0 || nodes.has(`${p.level}:${p.idx}`)
    ? [p]
    : [...expand({ level: p.level - 1, idx: 2 * p.idx }), ...expand({ level: p.level - 1, idx: 2 * p.idx + 1 })];
  const halves = (p: Part): Part[] => [
    ...expand({ level: p.level - 1, idx: 2 * p.idx }),
    ...expand({ level: p.level - 1, idx: 2 * p.idx + 1 }),
  ];
  const cost = (parts: Part[]) => parts.reduce((sum, p) => sum + line(p).length + 1, 0);

  let parts: Part[] = [];
  let start = 0;
  for (let level = MAX_LEVEL; level >= 0; level--) {
    if (leaves.length & 2 ** level) {
      parts.push(...expand({ level, idx: start >> level }));
      start += 2 ** level;
    }
  }
  let total = cost(parts);
  // Never more than the budget: drop the oldest lines (only before a backfill
  // has built the upper levels can the coarsest cover be too long).
  const OLDER_NOTE = '- (older history not summarized yet)';
  let droppedOld = false;
  while (total + (droppedOld ? OLDER_NOTE.length + 1 : 0) > budgetChars && parts.length > 1) {
    total -= line(parts[0]).length + 1;
    parts = parts.slice(1);
    droppedOld = true;
  }
  if (droppedOld) total += OLDER_NOTE.length + 1;

  for (;;) {
    let split = -1;
    for (let k = parts.length - 1; k >= 0; k--) {
      const p = parts[k];
      if (p.level === 0) continue;
      const next = parts[k + 1];
      if (next && next.level > p.level - 1) continue;
      split = k;
      break;
    }
    if (split < 0) break;
    const replacement = halves(parts[split]);
    const delta = cost(replacement) - cost([parts[split]]);
    if (total + delta > budgetChars) break;
    parts = [...parts.slice(0, split), ...replacement, ...parts.slice(split + 1)];
    total += delta;
  }

  const lines = parts.map(line);
  if (droppedOld) lines.unshift(OLDER_NOTE);
  return lines.join('\n');
}

/** A node's two halves as view lines, or a leaf's row in full. Null outside the tree. */
export function zoomNode(db: Database, project: string, level: number, idx: number): { text: string } | null {
  const leaves = loadLeaves(db, project);
  if (level < 0 || idx < 0 || (idx + 1) * 2 ** level > leaves.length) return null;
  if (level === 0) return { text: leafText(db, leaves[idx], true) ?? '(deleted)' };
  const nodes = loadNodes(db, project);
  return { text: [partLine(db, leaves, nodes, level - 1, 2 * idx), partLine(db, leaves, nodes, level - 1, 2 * idx + 1)].join('\n') };
}
