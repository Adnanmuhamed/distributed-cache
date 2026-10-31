/**
 * __tests__/gateway.integration.test.ts
 *
 * End-to-end integration tests for the distributed cache architecture.
 *
 * Strategy
 * ────────
 * Starts real HTTP servers in-process (using the same createNodeApp /
 * createGatewayApp factories that the standalone processes use) on
 * OS-assigned ephemeral ports, then makes real HTTP requests through
 * the gateway.  This exercises the complete request path:
 *
 *   Test → HTTP → Gateway → HTTP → CacheNode → CacheService
 *
 * without depending on ts-node child processes (which are slow and
 * environment-sensitive on Windows + Node 24).
 *
 * Port management
 * ───────────────
 * All servers listen on port 0 (OS-assigned). No static port constants
 * means zero risk of port conflicts with other test files.
 *
 * Coverage
 * ────────
 *   INT-A  Node health checks
 *   INT-B  Gateway health + /nodes
 *   INT-C  PUT → GET → DELETE flow
 *   INT-D  Consistent key placement
 *   INT-E  TTL expiry through gateway
 *   INT-F  Validation
 *   INT-G  Independent node storage (no replication)
 *   INT-H  Unavailable node returns 503/504 (no rerouting)
 */

import * as http from 'http';
import { createNodeApp } from '../node-server/nodeApp';
import { createGatewayApp, NodeConfig } from '../gateway/gatewayApp';

jest.setTimeout(30_000);

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface TestNode {
  nodeId: string;
  url: string;
  server: http.Server;
  cache: ReturnType<typeof createNodeApp>['cache'];
}

interface TestGateway {
  url: string;
  server: http.Server;
  ring: ReturnType<typeof createGatewayApp>['ring'];
}

async function startNodeServer(
  nodeId: string,
  policy: 'LRU' | 'LFU' = 'LRU',
  capacity = 50
): Promise<TestNode> {
  const { app, cache } = createNodeApp({ nodeId, capacity, policy });
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number };
      resolve({ nodeId, url: `http://localhost:${port}`, server, cache });
    });
    server.on('error', reject);
  });
}

async function startGatewayServer(
  nodeCfgs: NodeConfig[],
  virtualNodes = 100,
  requestTimeoutMs = 3000
): Promise<TestGateway> {
  const { app, ring } = createGatewayApp({ nodes: nodeCfgs, virtualNodes, requestTimeoutMs });
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number };
      resolve({ url: `http://localhost:${port}`, server, ring });
    });
    server.on('error', reject);
  });
}

function stopServer(server: http.Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()));
}

async function stopNode(node: TestNode): Promise<void> {
  node.cache.stopCleanup();
  await stopServer(node.server);
}

async function apiFetch(
  url: string,
  method: string,
  body?: object
): Promise<{ status: number; body: any }> {
  const opts: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  const json = await r.json().catch(() => ({}));
  return { status: r.status, body: json };
}

/** Force-expire a key in a node's cache (white-box). */
function forceExpire(cache: any, key: string): void {
  const map: Map<string, { expiresAt: number | null }> = cache.map;
  const node = map.get(key);
  if (node) node.expiresAt = Date.now() - 1;
}

// ─── Shared cluster for most test groups ─────────────────────────────────────

let nodes: TestNode[];
let gw: TestGateway;

beforeAll(async () => {
  nodes = await Promise.all([
    startNodeServer('cache-node-1'),
    startNodeServer('cache-node-2'),
    startNodeServer('cache-node-3'),
  ]);
  gw = await startGatewayServer(
    nodes.map(n => ({ nodeId: n.nodeId, url: n.url })),
    100,
    3000
  );
});

afterAll(async () => {
  await stopServer(gw.server);
  await Promise.all(nodes.map(stopNode));
});

// ─── INT-A: Node health checks ────────────────────────────────────────────────

describe('INT-A: Node server health checks', () => {
  test('INT-A1: each node responds to /health with 200 and its node ID', async () => {
    for (const node of nodes) {
      const { status, body } = await apiFetch(`${node.url}/health`, 'GET');
      expect(status).toBe(200);
      expect(body.status).toBe('ok');
      expect(body.nodeId).toBe(node.nodeId);
      expect(typeof body.size).toBe('number');
      expect(typeof body.capacity).toBe('number');
      expect(body.policy).toBe('LRU');
    }
  });

  test('INT-A2: node health size reflects actual cache size', async () => {
    nodes[0].cache.set('health-probe', 'val');
    const { body } = await apiFetch(`${nodes[0].url}/health`, 'GET');
    expect(body.size).toBeGreaterThanOrEqual(1);
    nodes[0].cache.delete('health-probe');
  });
});

// ─── INT-B: Gateway health + /nodes ──────────────────────────────────────────

describe('INT-B: Gateway health and /nodes', () => {
  test('INT-B1: gateway /health returns 200 with correct metadata', async () => {
    const { status, body } = await apiFetch(`${gw.url}/health`, 'GET');
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.role).toBe('gateway');
    expect(body.nodes).toHaveLength(3);
  });

  test('INT-B2: gateway /nodes reports all 3 nodes as up', async () => {
    const { status, body } = await apiFetch(`${gw.url}/nodes`, 'GET');
    expect(status).toBe(200);
    const upNodes = body.nodes.filter((n: any) => n.status === 'up');
    expect(upNodes.length).toBe(3);
  });

  test('INT-B3: gateway ring has correct virtual node count', () => {
    expect(gw.ring.nodeCount).toBe(3);
    expect(gw.ring.virtualNodeCount).toBe(300);
  });
});

// ─── INT-C: PUT → GET → DELETE flow ──────────────────────────────────────────

describe('INT-C: PUT → GET → DELETE complete flow', () => {
  test('INT-C1: PUT then GET via gateway returns stored value', async () => {
    const put = await apiFetch(`${gw.url}/cache`, 'PUT', { key: 'flow-key', value: 'flow-val' });
    expect(put.status).toBe(200);
    expect(put.body.success).toBe(true);

    const get = await apiFetch(`${gw.url}/cache/flow-key`, 'GET');
    expect(get.status).toBe(200);
    expect(get.body.data.value).toBe('flow-val');
  });

  test('INT-C2: DELETE removes key — subsequent GET returns 404', async () => {
    await apiFetch(`${gw.url}/cache`, 'PUT', { key: 'del-flow', value: 'x' });
    const del = await apiFetch(`${gw.url}/cache/del-flow`, 'DELETE');
    expect(del.status).toBe(200);

    const get = await apiFetch(`${gw.url}/cache/del-flow`, 'GET');
    expect(get.status).toBe(404);
  });

  test('INT-C3: GET missing key returns 404', async () => {
    const { status } = await apiFetch(`${gw.url}/cache/completely-absent-key`, 'GET');
    expect(status).toBe(404);
  });

  test('INT-C4: overwrite updates value in-place on the same node', async () => {
    await apiFetch(`${gw.url}/cache`, 'PUT', { key: 'ow-int', value: 'original' });
    await apiFetch(`${gw.url}/cache`, 'PUT', { key: 'ow-int', value: 'updated' });
    const get = await apiFetch(`${gw.url}/cache/ow-int`, 'GET');
    expect(get.body.data.value).toBe('updated');
  });

  test('INT-C5: DELETE non-existent key returns 404', async () => {
    const { status } = await apiFetch(`${gw.url}/cache/never-existed-int`, 'DELETE');
    expect(status).toBe(404);
  });
});

// ─── INT-D: Consistent key placement ─────────────────────────────────────────

describe('INT-D: Consistent key placement', () => {
  test('INT-D1: 30 PUT requests — keys spread across all 3 nodes, total = 30', async () => {
    // Clear nodes first to get accurate counts
    const initialSizes = nodes.map(n => n.cache.size);

    for (let i = 0; i < 30; i++) {
      await apiFetch(`${gw.url}/cache`, 'PUT', { key: `int-spread-${i}`, value: `v${i}` });
    }

    const finalSizes = nodes.map(n => n.cache.size);
    const added = finalSizes.map((s, i) => s - initialSizes[i]);
    const total = added.reduce((a, b) => a + b, 0);

    expect(total).toBe(30); // exactly 30 new keys, no duplicates
    for (const count of added) {
      expect(count).toBeGreaterThanOrEqual(2); // every node got at least some
    }
  });

  test('INT-D2: same key always routes to the same node (GET is idempotent)', async () => {
    await apiFetch(`${gw.url}/cache`, 'PUT', { key: 'sticky-int', value: 'sticky' });

    for (let i = 0; i < 5; i++) {
      const { status, body } = await apiFetch(`${gw.url}/cache/sticky-int`, 'GET');
      expect(status).toBe(200);
      expect(body.data.value).toBe('sticky');
    }
  });

  test('INT-D3: key is stored on exactly the node the ring selects', async () => {
    const key = 'ring-verify-key';
    const expectedNodeId = gw.ring.getNode(key)!;
    const expectedNode = nodes.find(n => n.nodeId === expectedNodeId)!;
    const otherNodes = nodes.filter(n => n.nodeId !== expectedNodeId);

    await apiFetch(`${gw.url}/cache`, 'PUT', { key, value: 'ring-val' });

    // Must be on the correct node
    expect(expectedNode.cache.get(key)).toBe('ring-val');

    // Must NOT be on any other node
    for (const n of otherNodes) {
      expect(n.cache.get(key)).toBeUndefined();
    }
  });
});

// ─── INT-E: TTL expiry through gateway ───────────────────────────────────────

describe('INT-E: TTL expiry through gateway', () => {
  test('INT-E1: key with TTL is stored then becomes unavailable after forced expiry', async () => {
    const key = 'ttl-int-test';
    await apiFetch(`${gw.url}/cache`, 'PUT', { key, value: 'ephemeral', ttl: 60 });

    // Immediately readable
    const get1 = await apiFetch(`${gw.url}/cache/${key}`, 'GET');
    expect(get1.status).toBe(200);

    // Force expire on the responsible node
    const nodeId = gw.ring.getNode(key)!;
    const owner = nodes.find(n => n.nodeId === nodeId)!;
    forceExpire(owner.cache, key);

    // Should now 404
    const get2 = await apiFetch(`${gw.url}/cache/${key}`, 'GET');
    expect(get2.status).toBe(404);
  });

  test('INT-E2: expiresAt is set correctly on the responsible node', async () => {
    const key = 'ttl-check-int';
    const before = Date.now();
    await apiFetch(`${gw.url}/cache`, 'PUT', { key, value: 'val', ttl: 120 });

    const nodeId = gw.ring.getNode(key)!;
    const owner = nodes.find(n => n.nodeId === nodeId)!;
    const map: Map<string, any> = (owner.cache as any).map;
    const entry = map.get(key);

    expect(entry).toBeDefined();
    expect(entry.expiresAt).toBeGreaterThan(before + 119_000);
    expect(entry.expiresAt).toBeLessThan(before + 121_000);
  });
});

// ─── INT-F: Validation ────────────────────────────────────────────────────────

describe('INT-F: Request validation', () => {
  test('INT-F1: PUT without key returns 400', async () => {
    const { status, body } = await apiFetch(`${gw.url}/cache`, 'PUT', { value: 'no-key' } as any);
    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  test('INT-F2: PUT without value returns 400', async () => {
    const { status } = await apiFetch(`${gw.url}/cache`, 'PUT', { key: 'k' } as any);
    expect(status).toBe(400);
  });

  test('INT-F3: PUT with non-numeric TTL returns 400', async () => {
    const { status } = await apiFetch(`${gw.url}/cache`, 'PUT', { key: 'k', value: 'v', ttl: 'bad' } as any);
    expect(status).toBe(400);
  });
});

// ─── INT-G: Independent node storage ─────────────────────────────────────────

describe('INT-G: Independent node storage — no replication', () => {
  test('INT-G1: key is stored on exactly 1 node', async () => {
    const key = 'isolation-int';
    await apiFetch(`${gw.url}/cache`, 'PUT', { key, value: 'isolated' });

    let foundCount = 0;
    for (const node of nodes) {
      const { status } = await apiFetch(`${node.url}/cache/${encodeURIComponent(key)}`, 'GET');
      if (status === 200) foundCount++;
    }

    expect(foundCount).toBe(1); // No replication
  });

  test('INT-G2: setting key directly on wrong node makes it invisible via gateway', async () => {
    const key = 'direct-wrong-node';
    const correctNodeId = gw.ring.getNode(key)!;
    const wrongNode = nodes.find(n => n.nodeId !== correctNodeId)!;

    // Set directly on wrong node (bypass gateway)
    wrongNode.cache.set(key, 'wrong');

    // Gateway routes to correct node → 404
    const { status } = await apiFetch(`${gw.url}/cache/${key}`, 'GET');
    expect(status).toBe(404);

    // Clean up
    wrongNode.cache.delete(key);
  });
});

// ─── INT-H: Unavailable node handling ────────────────────────────────────────

describe('INT-H: Unavailable node — 503/504, no rerouting', () => {
  test('INT-H1: gateway returns 503/504 for key mapped to dead node', async () => {
    // Create a gateway pointing to ghost ports
    const ghostNodes: NodeConfig[] = [
      { nodeId: 'cache-node-1', url: 'http://localhost:19961' },
      { nodeId: 'cache-node-2', url: 'http://localhost:19962' },
      { nodeId: 'cache-node-3', url: 'http://localhost:19963' },
    ];
    const deadGw = await startGatewayServer(ghostNodes, 10, 300);
    try {
      const res = await apiFetch(`${deadGw.url}/cache`, 'PUT', { key: 'ghost', value: 'x' });
      expect([503, 504]).toContain(res.status);
      expect(res.body.success).toBe(false);
      expect(typeof res.body.message).toBe('string');
    } finally {
      await stopServer(deadGw.server);
    }
  });

  test('INT-H2: gateway does not reroute to live nodes when responsible node is down', async () => {
    // Start only 2 real nodes; node-1 is a ghost
    const [n2, n3] = await Promise.all([
      startNodeServer('cache-node-2', 'LRU'),
      startNodeServer('cache-node-3', 'LRU'),
    ]);
    const partialGw = await startGatewayServer([
      { nodeId: 'cache-node-1', url: 'http://localhost:19971' }, // ghost
      { nodeId: 'cache-node-2', url: n2.url },
      { nodeId: 'cache-node-3', url: n3.url },
    ], 100, 300);

    try {
      // Find a key that the ring assigns to cache-node-1
      let ghostKey: string | null = null;
      for (let i = 0; i < 10_000; i++) {
        const k = `find-dead-${i}`;
        if (partialGw.ring.getNode(k) === 'cache-node-1') {
          ghostKey = k;
          break;
        }
      }
      expect(ghostKey).not.toBeNull();

      const res = await apiFetch(`${partialGw.url}/cache`, 'PUT', { key: ghostKey, value: 'x' });
      expect([503, 504]).toContain(res.status);

      // Key must NOT have been silently placed on another node
      expect(n2.cache.get(ghostKey!)).toBeUndefined();
      expect(n3.cache.get(ghostKey!)).toBeUndefined();
    } finally {
      await stopServer(partialGw.server);
      await Promise.all([stopNode(n2), stopNode(n3)]);
    }
  });
});
