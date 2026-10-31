/**
 * gateway/gateway.ts
 *
 * Entry point for the API gateway process.
 *
 * Configuration (environment variables)
 * ──────────────────────────────────────
 *   GATEWAY_PORT         Port for the gateway (default: 3000)
 *   VIRTUAL_NODES        Virtual nodes per physical node (default: 100)
 *   REQUEST_TIMEOUT_MS   Upstream request timeout in ms (default: 5000)
 *
 *   CACHE_NODE_1_ID      Node 1 id  (default: "cache-node-1")
 *   CACHE_NODE_1_URL     Node 1 url (default: "http://localhost:3001")
 *   CACHE_NODE_2_ID      Node 2 id  (default: "cache-node-2")
 *   CACHE_NODE_2_URL     Node 2 url (default: "http://localhost:3002")
 *   CACHE_NODE_3_ID      Node 3 id  (default: "cache-node-3")
 *   CACHE_NODE_3_URL     Node 3 url (default: "http://localhost:3003")
 *
 * Usage
 * ──────
 *   npx ts-node src/gateway/gateway.ts
 */

import { createGatewayApp } from './gatewayApp';
import { NodeConfig } from './gatewayApp';

const port = parseInt(process.env.GATEWAY_PORT ?? '3000', 10);
const virtualNodes = parseInt(process.env.VIRTUAL_NODES ?? '100', 10);
const requestTimeoutMs = parseInt(process.env.REQUEST_TIMEOUT_MS ?? '5000', 10);

const nodes: NodeConfig[] = [
  {
    nodeId: process.env.CACHE_NODE_1_ID ?? 'cache-node-1',
    url: process.env.CACHE_NODE_1_URL ?? 'http://localhost:3001',
  },
  {
    nodeId: process.env.CACHE_NODE_2_ID ?? 'cache-node-2',
    url: process.env.CACHE_NODE_2_URL ?? 'http://localhost:3002',
  },
  {
    nodeId: process.env.CACHE_NODE_3_ID ?? 'cache-node-3',
    url: process.env.CACHE_NODE_3_URL ?? 'http://localhost:3003',
  },
];

const { app } = createGatewayApp({ nodes, virtualNodes, requestTimeoutMs });

const server = app.listen(port, () => {
  console.log(`[Gateway] API gateway listening on port ${port}`);
  console.log(`[Gateway] Registered nodes: ${nodes.map(n => `${n.nodeId}@${n.url}`).join(', ')}`);
  console.log(`[Gateway] Virtual nodes per physical: ${virtualNodes}`);
});

function shutdown(signal: string): void {
  console.log(`[Gateway] Received ${signal}. Shutting down…`);
  server.close(() => {
    console.log('[Gateway] Server closed.');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
