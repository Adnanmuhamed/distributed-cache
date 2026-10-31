/**
 * gateway/gatewayApp.ts
 *
 * Express application factory for the API gateway.
 *
 * Responsibilities
 * ────────────────
 * • Maintains a ConsistentHashRing over the configured physical cache nodes.
 * • Routes PUT/GET/DELETE /cache requests to the responsible node using
 *   consistent hashing on the cache key.
 * • Proxies requests to cache nodes using the built-in Node.js fetch API
 *   (available since Node 18; project uses Node 24 per inspection).
 * • Does NOT reroute to another node when the responsible node is
 *   unavailable — returns 503 with a descriptive error instead.
 * • Exposes GET /health and GET /nodes for observability.
 *
 * Design decisions
 * ────────────────
 * 1. No replication or failover — per spec.
 * 2. fetch() timeout of REQUEST_TIMEOUT_MS (configurable, default 5 s).
 * 3. All errors from nodes are forwarded with the original status code
 *    where possible, or 502 on network/parse errors.
 * 4. Zero shared state with the node servers — each node is a fully
 *    independent process with its own CacheService instance.
 *
 * This file has NO side effects (no listen(), no process.exit()).
 */

import express, { Request, Response, NextFunction } from 'express';
import { ConsistentHashRing } from '../consistent-hash/ConsistentHashRing';
import { SetCacheRequest } from '../types';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface NodeConfig {
  /** Logical node id — must match what was added to the ring. */
  nodeId: string;
  /** Full base URL of the node, e.g. "http://localhost:3001". */
  url: string;
}

export interface GatewayAppOptions {
  /** Physical cache nodes to register in the ring. */
  nodes: NodeConfig[];
  /** Virtual nodes per physical node. Default: 100. */
  virtualNodes?: number;
  /** Per-request timeout when forwarding to cache nodes (ms). Default: 5000. */
  requestTimeoutMs?: number;
}

export interface GatewayAppResult {
  app: express.Application;
  ring: ConsistentHashRing;
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createGatewayApp(options: GatewayAppOptions): GatewayAppResult {
  const { nodes } = options;
  const virtualNodes = options.virtualNodes ?? 100;
  const requestTimeoutMs = options.requestTimeoutMs ?? 5_000;

  if (nodes.length === 0) {
    throw new Error('GatewayApp requires at least one node configuration.');
  }

  // Build the consistent hash ring.
  const ring = new ConsistentHashRing({ virtualNodes });
  const nodeUrlMap = new Map<string, string>(); // nodeId → baseUrl

  for (const n of nodes) {
    ring.addNode(n.nodeId);
    nodeUrlMap.set(n.nodeId, n.url.replace(/\/+$/, '')); // strip trailing slashes
  }

  const app = express();
  app.use(express.json());

  // ── Internal helpers ───────────────────────────────────────────────────────

  /**
   * Look up the responsible node for a cache key.
   * Returns { nodeId, url } or throws a typed error if the ring is empty.
   */
  function resolveNode(key: string): { nodeId: string; url: string } {
    const nodeId = ring.getNode(key);
    if (!nodeId) throw new Error('Hash ring is empty — no nodes available.');
    const url = nodeUrlMap.get(nodeId);
    if (!url) throw new Error(`Internal: no URL for node "${nodeId}".`);
    return { nodeId, url };
  }

  /**
   * Forward a request to a cache node with a configurable timeout.
   * Returns the parsed JSON body and the HTTP status code from the node.
   * Throws a GatewayError on network failures or timeouts.
   */
  async function proxyRequest(opts: {
    method: string;
    url: string;
    body?: unknown;
  }): Promise<{ status: number; body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);

    try {
      const fetchOpts: RequestInit = {
        method: opts.method,
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
      };
      if (opts.body !== undefined) {
        fetchOpts.body = JSON.stringify(opts.body);
      }

      const resp = await fetch(opts.url, fetchOpts);
      const body = await resp.json().catch(() => ({}));
      return { status: resp.status, body };
    } catch (err: unknown) {
      const e = err as Error;
      if (e.name === 'AbortError') {
        throw Object.assign(new Error(`Request to ${opts.url} timed out after ${requestTimeoutMs}ms`), {
          code: 'GATEWAY_TIMEOUT',
        });
      }
      throw Object.assign(new Error(`Network error reaching ${opts.url}: ${e.message}`), {
        code: 'GATEWAY_UPSTREAM_ERROR',
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // ── GET /health ────────────────────────────────────────────────────────────
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      role: 'gateway',
      nodes: nodes.map(n => n.nodeId),
      virtualNodesPerPhysical: virtualNodes,
      timestamp: new Date().toISOString(),
    });
  });

  // ── GET /nodes ─────────────────────────────────────────────────────────────
  // Returns the list of registered nodes and (async) their health status.
  app.get('/nodes', async (_req: Request, res: Response) => {
    const checks = await Promise.allSettled(
      nodes.map(async n => {
        try {
          const controller = new AbortController();
          const t = setTimeout(() => controller.abort(), 2_000);
          const r = await fetch(`${n.url}/health`, { signal: controller.signal });
          clearTimeout(t);
          const body = await r.json();
          return { nodeId: n.nodeId, url: n.url, status: 'up', detail: body };
        } catch {
          return { nodeId: n.nodeId, url: n.url, status: 'down' };
        }
      })
    );

    const nodeStatuses = checks.map(c =>
      c.status === 'fulfilled' ? c.value : { status: 'error' }
    );

    res.status(200).json({ gateway: 'ok', nodes: nodeStatuses });
  });

  // ── PUT /cache ─────────────────────────────────────────────────────────────
  app.put('/cache', async (req: Request, res: Response) => {
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

    let nodeId: string, nodeUrl: string;
    try {
      const resolved = resolveNode(key);
      nodeId = resolved.nodeId;
      nodeUrl = resolved.url;
    } catch (err) {
      return res.status(503).json({ success: false, message: (err as Error).message });
    }

    try {
      const { status, body } = await proxyRequest({
        method: 'PUT',
        url: `${nodeUrl}/cache`,
        body: req.body,
      });
      return res.status(status).json(body);
    } catch (err: unknown) {
      const e = err as Error & { code?: string };
      const httpStatus = e.code === 'GATEWAY_TIMEOUT' ? 504 : 503;
      return res.status(httpStatus).json({
        success: false,
        message: `Node "${nodeId}" is unavailable: ${e.message}`,
        node: nodeId,
      });
    }
  });

  // ── GET /cache/:key ────────────────────────────────────────────────────────
  app.get('/cache/:key', async (req: Request, res: Response) => {
    const { key } = req.params;

    let nodeId: string, nodeUrl: string;
    try {
      const resolved = resolveNode(key);
      nodeId = resolved.nodeId;
      nodeUrl = resolved.url;
    } catch (err) {
      return res.status(503).json({ success: false, message: (err as Error).message });
    }

    try {
      const { status, body } = await proxyRequest({
        method: 'GET',
        url: `${nodeUrl}/cache/${encodeURIComponent(key)}`,
      });
      return res.status(status).json(body);
    } catch (err: unknown) {
      const e = err as Error & { code?: string };
      const httpStatus = e.code === 'GATEWAY_TIMEOUT' ? 504 : 503;
      return res.status(httpStatus).json({
        success: false,
        message: `Node "${nodeId}" is unavailable: ${e.message}`,
        node: nodeId,
      });
    }
  });

  // ── DELETE /cache/:key ─────────────────────────────────────────────────────
  app.delete('/cache/:key', async (req: Request, res: Response) => {
    const { key } = req.params;

    let nodeId: string, nodeUrl: string;
    try {
      const resolved = resolveNode(key);
      nodeId = resolved.nodeId;
      nodeUrl = resolved.url;
    } catch (err) {
      return res.status(503).json({ success: false, message: (err as Error).message });
    }

    try {
      const { status, body } = await proxyRequest({
        method: 'DELETE',
        url: `${nodeUrl}/cache/${encodeURIComponent(key)}`,
      });
      return res.status(status).json(body);
    } catch (err: unknown) {
      const e = err as Error & { code?: string };
      const httpStatus = e.code === 'GATEWAY_TIMEOUT' ? 504 : 503;
      return res.status(httpStatus).json({
        success: false,
        message: `Node "${nodeId}" is unavailable: ${e.message}`,
        node: nodeId,
      });
    }
  });

  // ── Global error handler ──────────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error('[Gateway] Unhandled error:', err.message);
    res.status(500).json({ success: false, message: 'Internal gateway error.' });
  });

  return { app, ring };
}
