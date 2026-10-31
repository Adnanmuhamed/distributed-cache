/**
 * node-server/nodeApp.ts
 *
 * Express application factory for a single distributed cache node.
 *
 * Responsibilities
 * ────────────────
 * • Exposes the existing CacheService via REST endpoints:
 *     PUT    /cache          — set a key
 *     GET    /cache/:key     — get a key
 *     DELETE /cache/:key     — delete a key
 *     GET    /health         — liveness / readiness probe
 *
 * • Configuration via constructor arguments (driven by env vars in
 *   nodeServer.ts, or by test code directly).
 *
 * • Returns the Express app and the CacheService instance so callers
 *   can call stopCleanup() on shutdown.
 *
 * This file has NO side effects (no listen(), no process.exit()).
 */

import express, { Request, Response, NextFunction } from 'express';
import { CacheService } from '../services/cache.service';
import { EvictionPolicy, SetCacheRequest } from '../types';

export interface NodeAppOptions {
  /** Physical node identifier (used in health-check response). */
  nodeId: string;
  /** Maximum number of entries before eviction. Default: 100. */
  capacity?: number;
  /** Eviction policy. Default: 'LRU'. */
  policy?: EvictionPolicy;
}

export interface NodeAppResult {
  app: express.Application;
  cache: CacheService;
}

export function createNodeApp(options: NodeAppOptions): NodeAppResult {
  const { nodeId } = options;
  const capacity = options.capacity ?? 100;
  const policy: EvictionPolicy = options.policy ?? 'LRU';

  const cache = new CacheService(capacity, policy);
  const app = express();

  app.use(express.json());

  // ── Health check ──────────────────────────────────────────────────────────
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      nodeId,
      policy,
      capacity,
      size: cache.size,
      timestamp: new Date().toISOString(),
    });
  });

  // ── PUT /cache ────────────────────────────────────────────────────────────
  app.put('/cache', (req: Request, res: Response) => {
    const { key, value, ttl } = req.body as SetCacheRequest;

    if (key === undefined || typeof key !== 'string' || value === undefined || typeof value !== 'string') {
      return res.status(400).json({
        success: false,
        message: 'Invalid request body. "key" and "value" must be strings.',
      });
    }

    if (ttl !== undefined && typeof ttl !== 'number') {
      return res.status(400).json({
        success: false,
        message: 'Invalid request body. "ttl" must be a number.',
      });
    }

    cache.set(key, value, ttl);

    return res.status(200).json({
      success: true,
      message: 'Cache entry stored successfully.',
    });
  });

  // ── GET /cache/:key ───────────────────────────────────────────────────────
  app.get('/cache/:key', (req: Request, res: Response) => {
    const { key } = req.params;
    const value = cache.get(key);

    if (value === undefined) {
      return res.status(404).json({
        success: false,
        message: 'Cache entry not found or expired.',
      });
    }

    return res.status(200).json({
      success: true,
      data: { key, value },
    });
  });

  // ── DELETE /cache/:key ────────────────────────────────────────────────────
  app.delete('/cache/:key', (req: Request, res: Response) => {
    const { key } = req.params;
    const deleted = cache.delete(key);

    if (!deleted) {
      return res.status(404).json({
        success: false,
        message: 'Cache entry not found.',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Cache entry deleted successfully.',
    });
  });

  // ── Global error handler ──────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(`[${nodeId}] Unhandled error:`, err.message);
    res.status(500).json({ success: false, message: 'Internal server error.' });
  });

  return { app, cache };
}
