/**
 * __tests__/gateway.unit.test.ts
 *
 * Unit / in-process tests for the API gateway (createGatewayApp).
 *
 * These tests use supertest for the gateway but start real in-process
 * node-app instances (no separate processes).  The gateway's fetch()
 * calls are intercepted by routing to http://localhost:<ephemeral-port>
 * where the node app is actually listening.
 *
 * Covers:
 *   A. Gateway health check + /nodes endpoint
 *   B. Consistent key routing (PUT → correct node)
 *   C. GET routing — hit on correct node, miss on wrong node
 *   D. DELETE routing
 *   E. Unavailable node handling (503/504)
 *   F. Request validation forwarded correctly
 *   G. Keys from different groups land on different nodes
 *   H. TTL forwarded correctly
 */

import request from 'supertest';
import * as http from 'http';
import { createNodeApp } from '../node-server/nodeApp';
import { createGatewayApp, NodeConfig } from '../gateway/gatewayApp';
import { ConsistentHashRing } from '../consistent-hash/ConsistentHashRing';

// ─── Setup: start 3 real in-process node servers on random ports ──────────────

interface RunningNode {
  nodeId: string;
  url: string;
  server: http.Server;
  cache: InstanceType<typeof import('../services/cache.service').CacheService>;
}

async function startNode(nodeId: string, policy: 'LRU' | 'LFU' = 'LRU'): Promise<RunningNode> {
  const { app, cache } = createNodeApp({ nodeId, capacity: 20, policy });
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => { // port 0 = OS assigns a free port
      const addr = server.address() as { port: number };
      resolve({ nodeId, url: `http://localhost:${addr.port}`, server, cache });
    });
    server.on('error', reject);
  });
}

async function stopNode(node: RunningNode): Promise<void> {
  node.cache.stopCleanup();
  return new Promise(resolve => node.server.close(() => resolve()));
}

// ─── A. Gateway health check ──────────────────────────────────────────────────
describe('A. Gateway health check and /nodes', () => {
  let nodes: RunningNode[];
  let gwApp: ReturnType<typeof createGatewayApp>;

  beforeAll(async () => {
    nodes = await Promise.all([
      startNode('cache-node-1'),
      startNode('cache-node-2'),
      startNode('cache-node-3'),
    ]);
    const nodeCfg: NodeConfig[] = nodes.map(n => ({ nodeId: n.nodeId, url: n.url }));
    gwApp = createGatewayApp({ nodes: nodeCfg, virtualNodes: 50, requestTimeoutMs: 2000 });
  });

  afterAll(async () => {
    await Promise.all(nodes.map(stopNode));
  });

  test('A1: GET /health returns 200 with gateway metadata', async () => {
    const res = await request(gwApp.app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.role).toBe('gateway');
    expect(Array.isArray(res.body.nodes)).toBe(true);
    expect(res.body.nodes).toHaveLength(3);
  });

  test('A2: GET /nodes returns status for each node', async () => {
    const res = await request(gwApp.app).get('/nodes');
    expect(res.status).toBe(200);
    expect(res.body.gateway).toBe('ok');
    expect(Array.isArray(res.body.nodes)).toBe(true);
    const upNodes = res.body.nodes.filter((n: any) => n.status === 'up');
    expect(upNodes.length).toBe(3);
  });

  test('A3: gateway ring has 3 nodes and 150 virtual nodes (50 × 3)', () => {
    expect(gwApp.ring.nodeCount).toBe(3);
    expect(gwApp.ring.virtualNodeCount).toBe(150);
  });
});

// ─── B. Consistent key routing ────────────────────────────────────────────────
describe('B. Consistent key routing — PUT routes to correct node', () => {
  let nodes: RunningNode[];
  let gwApp: ReturnType<typeof createGatewayApp>;
  let ring: ConsistentHashRing;

  beforeAll(async () => {
    nodes = await Promise.all([
      startNode('cache-node-1'),
      startNode('cache-node-2'),
      startNode('cache-node-3'),
    ]);
    const nodeCfg: NodeConfig[] = nodes.map(n => ({ nodeId: n.nodeId, url: n.url }));
    const result = createGatewayApp({ nodes: nodeCfg, virtualNodes: 100, requestTimeoutMs: 2000 });
    gwApp = result;
    ring = result.ring;
  });

  afterAll(async () => {
    await Promise.all(nodes.map(stopNode));
  });

  test('B1: a PUT via the gateway stores the key on the node the ring selects', async () => {
    const key = 'routing-test-key';
    const responsibleNodeId = ring.getNode(key)!;
    const responsibleNode = nodes.find(n => n.nodeId === responsibleNodeId)!;

    await request(gwApp.app).put('/cache').send({ key, value: 'routed-value' });

    // Value must be in the responsible node's cache
    expect(responsibleNode.cache.get(key)).toBe('routed-value');

    // Value must NOT be in other nodes
    for (const n of nodes) {
      if (n.nodeId !== responsibleNodeId) {
        expect(n.cache.get(key)).toBeUndefined();
      }
    }
  });

  test('B2: 20 different keys each land on exactly the ring-predicted node', async () => {
    const keys = Array.from({ length: 20 }, (_, i) => `batch-key-${i}`);
    for (const key of keys) {
      await request(gwApp.app).put('/cache').send({ key, value: `val-${key}` });
    }

    for (const key of keys) {
      const expected = ring.getNode(key)!;
      const owner = nodes.find(n => n.nodeId === expected)!;
      expect(owner.cache.get(key)).toBe(`val-${key}`);

      // Not on other nodes
      for (const n of nodes) {
        if (n.nodeId !== expected) {
          expect(n.cache.get(key)).toBeUndefined();
        }
      }
    }
  });
});

// ─── C. GET routing ───────────────────────────────────────────────────────────
describe('C. GET routing — hit and miss', () => {
  let nodes: RunningNode[];
  let gwApp: ReturnType<typeof createGatewayApp>;
  let ring: ConsistentHashRing;

  beforeAll(async () => {
    nodes = await Promise.all([
      startNode('cache-node-1'),
      startNode('cache-node-2'),
      startNode('cache-node-3'),
    ]);
    const nodeCfg = nodes.map(n => ({ nodeId: n.nodeId, url: n.url }));
    const result = createGatewayApp({ nodes: nodeCfg, virtualNodes: 100, requestTimeoutMs: 2000 });
    gwApp = result;
    ring = result.ring;
  });

  afterAll(async () => {
    await Promise.all(nodes.map(stopNode));
  });

  test('C1: GET after PUT returns the stored value', async () => {
    await request(gwApp.app).put('/cache').send({ key: 'c-key', value: 'c-val' });
    const res = await request(gwApp.app).get('/cache/c-key');
    expect(res.status).toBe(200);
    expect(res.body.data.value).toBe('c-val');
  });

  test('C2: GET for a non-existent key returns 404', async () => {
    const res = await request(gwApp.app).get('/cache/totally-absent');
    expect(res.status).toBe(404);
  });

  test('C3: GET always queries the same node for the same key', async () => {
    const key = 'stable-routing-key';
    const nodeId = ring.getNode(key)!;
    const owner = nodes.find(n => n.nodeId === nodeId)!;

    // Set directly on the responsible node (bypassing gateway)
    owner.cache.set(key, 'direct-value');

    const res = await request(gwApp.app).get(`/cache/${key}`);
    expect(res.status).toBe(200);
    expect(res.body.data.value).toBe('direct-value');
  });

  test('C4: key placed on wrong node directly is not found via gateway', async () => {
    const key = 'wrong-node-key';
    const correctNodeId = ring.getNode(key)!;
    // Put on a node that is NOT the responsible one
    const wrongNode = nodes.find(n => n.nodeId !== correctNodeId)!;
    wrongNode.cache.set(key, 'wrong-placement');

    const res = await request(gwApp.app).get(`/cache/${key}`);
    // Gateway routes to the correct node which doesn't have it → 404
    expect(res.status).toBe(404);
  });
});

// ─── D. DELETE routing ────────────────────────────────────────────────────────
describe('D. DELETE routing', () => {
  let nodes: RunningNode[];
  let gwApp: ReturnType<typeof createGatewayApp>;

  beforeAll(async () => {
    nodes = await Promise.all([
      startNode('cache-node-1'),
      startNode('cache-node-2'),
      startNode('cache-node-3'),
    ]);
    const nodeCfg = nodes.map(n => ({ nodeId: n.nodeId, url: n.url }));
    gwApp = createGatewayApp({ nodes: nodeCfg, virtualNodes: 100, requestTimeoutMs: 2000 });
  });

  afterAll(async () => {
    await Promise.all(nodes.map(stopNode));
  });

  test('D1: DELETE after PUT returns 200 and removes the key', async () => {
    await request(gwApp.app).put('/cache').send({ key: 'del-key', value: 'bye' });
    const del = await request(gwApp.app).delete('/cache/del-key');
    expect(del.status).toBe(200);
    expect(del.body.success).toBe(true);

    const get = await request(gwApp.app).get('/cache/del-key');
    expect(get.status).toBe(404);
  });

  test('D2: DELETE non-existent key returns 404', async () => {
    const res = await request(gwApp.app).delete('/cache/never-existed');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  test('D3: double DELETE returns 404 on second call', async () => {
    await request(gwApp.app).put('/cache').send({ key: 'del-twice', value: 'x' });
    await request(gwApp.app).delete('/cache/del-twice');
    const res = await request(gwApp.app).delete('/cache/del-twice');
    expect(res.status).toBe(404);
  });
});

// ─── E. Unavailable node handling ─────────────────────────────────────────────
describe('E. Unavailable node — returns 503 without crashing', () => {
  test('E1: gateway returns 503/504 when the responsible node is not running', async () => {
    // Point node URLs to ports nothing is listening on
    const ghostNodes: NodeConfig[] = [
      { nodeId: 'cache-node-1', url: 'http://localhost:19901' },
      { nodeId: 'cache-node-2', url: 'http://localhost:19902' },
      { nodeId: 'cache-node-3', url: 'http://localhost:19903' },
    ];
    const { app } = createGatewayApp({
      nodes: ghostNodes,
      virtualNodes: 10,
      requestTimeoutMs: 500,
    });

    const res = await request(app).put('/cache').send({ key: 'any', value: 'any' });
    expect([503, 504]).toContain(res.status);
    expect(res.body.success).toBe(false);
    expect(typeof res.body.message).toBe('string');
    expect(res.body.message.length).toBeGreaterThan(0);
  });

  test('E2: GET to unavailable node returns 503/504 with node id in response', async () => {
    const ghostNodes: NodeConfig[] = [
      { nodeId: 'cache-node-1', url: 'http://localhost:19911' },
      { nodeId: 'cache-node-2', url: 'http://localhost:19912' },
      { nodeId: 'cache-node-3', url: 'http://localhost:19913' },
    ];
    const { app } = createGatewayApp({
      nodes: ghostNodes,
      virtualNodes: 10,
      requestTimeoutMs: 500,
    });

    const res = await request(app).get('/cache/some-key');
    expect([503, 504]).toContain(res.status);
    expect(res.body.success).toBe(false);
    expect(typeof res.body.node).toBe('string'); // which node failed
  });

  test('E3: DELETE to unavailable node returns 503/504', async () => {
    const ghostNodes: NodeConfig[] = [
      { nodeId: 'cache-node-1', url: 'http://localhost:19921' },
      { nodeId: 'cache-node-2', url: 'http://localhost:19922' },
      { nodeId: 'cache-node-3', url: 'http://localhost:19923' },
    ];
    const { app } = createGatewayApp({
      nodes: ghostNodes,
      virtualNodes: 10,
      requestTimeoutMs: 500,
    });

    const res = await request(app).delete('/cache/key');
    expect([503, 504]).toContain(res.status);
    expect(res.body.success).toBe(false);
  });

  test('E4: gateway does NOT reroute to another node when one is down', async () => {
    // Only node-2 and node-3 are real; node-1 is a ghost.
    // Keys that hash to node-1 must return 503, not silently succeed via node-2 or -3.
    const [realNode2, realNode3] = await Promise.all([
      startNode('cache-node-2'),
      startNode('cache-node-3'),
    ]);

    const mixedNodes: NodeConfig[] = [
      { nodeId: 'cache-node-1', url: 'http://localhost:19931' }, // ghost
      { nodeId: 'cache-node-2', url: realNode2.url },
      { nodeId: 'cache-node-3', url: realNode3.url },
    ];

    const { app, ring } = createGatewayApp({
      nodes: mixedNodes,
      virtualNodes: 100,
      requestTimeoutMs: 500,
    });

    // Find a key that the ring assigns to cache-node-1
    let ghostKey: string | null = null;
    for (let i = 0; i < 10_000; i++) {
      const k = `find-ghost-${i}`;
      if (ring.getNode(k) === 'cache-node-1') {
        ghostKey = k;
        break;
      }
    }

    expect(ghostKey).not.toBeNull();

    const res = await request(app).put('/cache').send({ key: ghostKey, value: 'x' });
    expect([503, 504]).toContain(res.status); // must fail, not silently reroute

    // Confirm the key is not on any surviving node
    expect(realNode2.cache.get(ghostKey!)).toBeUndefined();
    expect(realNode3.cache.get(ghostKey!)).toBeUndefined();

    await Promise.all([stopNode(realNode2), stopNode(realNode3)]);
  });
});

// ─── F. Validation forwarded correctly ────────────────────────────────────────
describe('F. Request validation through gateway', () => {
  let nodes: RunningNode[];
  let gwApp: ReturnType<typeof createGatewayApp>;

  beforeAll(async () => {
    nodes = await Promise.all([
      startNode('cache-node-1'),
      startNode('cache-node-2'),
      startNode('cache-node-3'),
    ]);
    gwApp = createGatewayApp({
      nodes: nodes.map(n => ({ nodeId: n.nodeId, url: n.url })),
      virtualNodes: 100,
      requestTimeoutMs: 2000,
    });
  });

  afterAll(async () => {
    await Promise.all(nodes.map(stopNode));
  });

  test('F1: gateway rejects PUT without key with 400', async () => {
    const res = await request(gwApp.app).put('/cache').send({ value: 'v' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('F2: gateway rejects PUT with non-string ttl with 400', async () => {
    const res = await request(gwApp.app).put('/cache').send({ key: 'k', value: 'v', ttl: 'bad' });
    expect(res.status).toBe(400);
  });
});

// ─── G. Multi-key placement correctness ──────────────────────────────────────
describe('G. Multi-key placement — keys spread across nodes', () => {
  let nodes: RunningNode[];
  let gwApp: ReturnType<typeof createGatewayApp>;

  beforeAll(async () => {
    nodes = await Promise.all([
      startNode('cache-node-1'),
      startNode('cache-node-2'),
      startNode('cache-node-3'),
    ]);
    gwApp = createGatewayApp({
      nodes: nodes.map(n => ({ nodeId: n.nodeId, url: n.url })),
      virtualNodes: 100,
      requestTimeoutMs: 2000,
    });
  });

  afterAll(async () => {
    await Promise.all(nodes.map(stopNode));
  });

  test('G1: 60 PUT requests result in keys spread across all 3 nodes', async () => {
    for (let i = 0; i < 60; i++) {
      await request(gwApp.app).put('/cache').send({ key: `spread-${i}`, value: `v${i}` });
    }
    const sizes = nodes.map(n => n.cache.size);
    // Each node should have received at least 5 keys (very conservative lower bound)
    for (const s of sizes) {
      expect(s).toBeGreaterThan(5);
    }
    // Total keys = 60 (no double-storage)
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(60);
  });
});

// ─── H. TTL forwarded correctly ───────────────────────────────────────────────
describe('H. TTL forwarded through gateway', () => {
  let nodes: RunningNode[];
  let gwApp: ReturnType<typeof createGatewayApp>;
  let ring: ConsistentHashRing;

  beforeAll(async () => {
    nodes = await Promise.all([
      startNode('cache-node-1'),
      startNode('cache-node-2'),
      startNode('cache-node-3'),
    ]);
    const result = createGatewayApp({
      nodes: nodes.map(n => ({ nodeId: n.nodeId, url: n.url })),
      virtualNodes: 100,
      requestTimeoutMs: 2000,
    });
    gwApp = result;
    ring = result.ring;
  });

  afterAll(async () => {
    await Promise.all(nodes.map(stopNode));
  });

  test('H1: TTL is stored on the responsible node and respects expiry', async () => {
    const key = 'ttl-gateway-key';
    await request(gwApp.app).put('/cache').send({ key, value: 'ephemeral', ttl: 60 });

    // Verify TTL set on responsible node
    const nodeId = ring.getNode(key)!;
    const owner = nodes.find(n => n.nodeId === nodeId)!;
    const nodeMap: Map<string, { expiresAt: number | null }> = (owner.cache as any).map;
    const entry = nodeMap.get(key);
    expect(entry).toBeDefined();
    expect(entry!.expiresAt).not.toBeNull();

    // Force expiry
    entry!.expiresAt = Date.now() - 1;

    // GET via gateway should now 404
    const res = await request(gwApp.app).get(`/cache/${key}`);
    expect(res.status).toBe(404);
  });
});
