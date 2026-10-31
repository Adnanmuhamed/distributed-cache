/**
 * node-server/nodeServer.ts
 *
 * Entry point for a single distributed cache node process.
 *
 * Configuration (environment variables)
 * ──────────────────────────────────────
 *   NODE_ID        Logical node name (default: "cache-node-1")
 *   PORT           TCP port to listen on (default: 3001)
 *   CAPACITY       Max cache entries before eviction (default: 100)
 *   POLICY         Eviction policy: "LRU" or "LFU" (default: "LRU")
 *
 * Usage examples
 * ──────────────
 *   # Node 1
 *   NODE_ID=cache-node-1 PORT=3001 npx ts-node src/node-server/nodeServer.ts
 *
 *   # Node 2 with LFU
 *   NODE_ID=cache-node-2 PORT=3002 POLICY=LFU npx ts-node src/node-server/nodeServer.ts
 */

import { createNodeApp } from './nodeApp';
import { EvictionPolicy } from '../types';

const nodeId = process.env.NODE_ID ?? 'cache-node-1';
const port = parseInt(process.env.PORT ?? '3001', 10);
const capacity = parseInt(process.env.CAPACITY ?? '100', 10);
const rawPolicy = (process.env.POLICY ?? 'LRU').toUpperCase();
const policy: EvictionPolicy = rawPolicy === 'LFU' ? 'LFU' : 'LRU';

const { app, cache } = createNodeApp({ nodeId, capacity, policy });

const server = app.listen(port, () => {
  console.log(`[${nodeId}] Cache node listening on port ${port} (policy=${policy}, capacity=${capacity})`);
});

// Graceful shutdown
function shutdown(signal: string): void {
  console.log(`[${nodeId}] Received ${signal}. Shutting down…`);
  cache.stopCleanup();
  server.close(() => {
    console.log(`[${nodeId}] Server closed.`);
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
