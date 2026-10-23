/**
 * Fork Phase 2: the memory tree over HTTP (memory-tree/MemoryTree.ts).
 * GET /api/memory-tree/zoom?project&level&idx answers a node's two halves, or
 * a leaf's row, as text (the memory_zoom MCP tool); GET /api/memory-tree/status
 * says how far a project's tree is built. Read-only.
 */
import express, { Request, Response } from 'express';
import { DatabaseManager } from '../../DatabaseManager.js';
import { BaseRouteHandler } from '../BaseRouteHandler.js';
import { leafCount, readyMerges, zoomNode } from '../../../memory-tree/MemoryTree.js';

const WHOLE_NUMBER = /^\d{1,9}$/;

export class MemoryTreeRoutes extends BaseRouteHandler {
  constructor(private dbManager: DatabaseManager) {
    super();
  }

  setupRoutes(app: express.Application): void {
    app.get('/api/memory-tree/zoom', this.handleZoom.bind(this));
    app.get('/api/memory-tree/status', this.handleStatus.bind(this));
  }

  private handleZoom = this.wrapHandler((req: Request, res: Response): void => {
    const project = BaseRouteHandler.firstString(req.query.project);
    const level = BaseRouteHandler.firstString(req.query.level) ?? '';
    const idx = BaseRouteHandler.firstString(req.query.idx) ?? '';
    if (!project || !WHOLE_NUMBER.test(level) || !WHOLE_NUMBER.test(idx)) {
      res.status(400).type('text/plain').send('memory_zoom needs project, and level and idx as whole numbers ([Lk:i] → level k, idx i).');
      return;
    }
    const zoomed = zoomNode(this.dbManager.getSessionStore().db, project, Number(level), Number(idx));
    if (!zoomed) {
      res.status(404).type('text/plain').send(`No [L${level}:${idx}] in the memory tree of ${project}.`);
      return;
    }
    res.status(200).type('text/plain').send(zoomed.text);
  });

  private handleStatus = this.wrapHandler((req: Request, res: Response): void => {
    const project = BaseRouteHandler.firstString(req.query.project);
    if (!project) {
      res.status(400).json({ error: 'project is required' });
      return;
    }
    const db = this.dbManager.getSessionStore().db;
    const nodes = (db.prepare('SELECT COUNT(*) AS n FROM memory_nodes WHERE project = ?').get(project) as { n: number }).n;
    res.json({ project, leaves: leafCount(db, project), nodes, ready: readyMerges(db, project, 1_000_000).length });
  });
}
