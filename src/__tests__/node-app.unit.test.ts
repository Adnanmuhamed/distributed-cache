/**
 * __tests__/node-app.unit.test.ts
 *
 * Unit tests for the cache node Express application (createNodeApp).
 * Uses supertest — no real network ports needed for these tests.
 *
 * Covers:
 *   A. Health check
 *   B. PUT /cache — set operations, validation
 *   C. GET /cache/:key — hits, misses, TTL
 *   D. DELETE /cache/:key — deletes, missing key
 *   E. LRU eviction behaviour
 *   F. LFU eviction behaviour
 *   G. Independent storage per instance
 */

import request from 'supertest';
import { createNodeApp } from '../node-server/nodeApp';

// Helper to force-expire a key in the cache (white-box)
function expireKey(cache: any, key: string): void {
  const map: Map<string, { expiresAt: number | null }> = cache.map;
  const node = map.get(key);
  if (!node) throw new Error(`Key "${key}" not in cache map`);
  node.expiresAt = Date.now() - 1;
}

// ─── A. Health check ──────────────────────────────────────────────────────────
describe('A. Node health check', () => {
  const { app, cache } = createNodeApp({ nodeId: 'test-node', capacity: 10, policy: 'LRU' });
  afterAll(() => cache.stopCleanup());

  test('A1: GET /health returns 200 with correct shape', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.nodeId).toBe('test-node');
    expect(res.body.policy).toBe('LRU');
    expect(res.body.capacity).toBe(10);
    expect(typeof res.body.size).toBe('number');
    expect(typeof res.body.timestamp).toBe('string');
  });

  test('A2: health size reflects current cache size', async () => {
    cache.set('probe', 'val');
    const res = await request(app).get('/health');
    expect(res.body.size).toBeGreaterThanOrEqual(1);
    cache.delete('probe');
  });
});

// ─── B. PUT /cache ────────────────────────────────────────────────────────────
describe('B. PUT /cache — set operations', () => {
  const { app, cache } = createNodeApp({ nodeId: 'n1', capacity: 10, policy: 'LRU' });
  afterAll(() => cache.stopCleanup());

  test('B1: PUT with valid key+value returns 200', async () => {
    const res = await request(app).put('/cache').send({ key: 'hello', value: 'world' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('B2: PUT with TTL returns 200', async () => {
    const res = await request(app).put('/cache').send({ key: 'ttl-key', value: 'ttl-val', ttl: 60 });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('B3: PUT without key returns 400', async () => {
    const res = await request(app).put('/cache').send({ value: 'no-key' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('B4: PUT without value returns 400', async () => {
    const res = await request(app).put('/cache').send({ key: 'no-val' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('B5: PUT with numeric key returns 400', async () => {
    const res = await request(app).put('/cache').send({ key: 42, value: 'bad' });
    expect(res.status).toBe(400);
  });

  test('B6: PUT with non-numeric ttl returns 400', async () => {
    const res = await request(app).put('/cache').send({ key: 'k', value: 'v', ttl: 'bad' });
    expect(res.status).toBe(400);
  });

  test('B7: PUT stores the value retrievable via cache.get()', async () => {
    await request(app).put('/cache').send({ key: 'stored', value: 'data' });
    expect(cache.get('stored')).toBe('data');
  });

  test('B8: PUT overwrites an existing key', async () => {
    await request(app).put('/cache').send({ key: 'ow', value: 'original' });
    await request(app).put('/cache').send({ key: 'ow', value: 'updated' });
    expect(cache.get('ow')).toBe('updated');
  });
});

// ─── C. GET /cache/:key ───────────────────────────────────────────────────────
describe('C. GET /cache/:key', () => {
  const { app, cache } = createNodeApp({ nodeId: 'n2', capacity: 10, policy: 'LRU' });
  afterAll(() => cache.stopCleanup());

  beforeEach(() => {
    cache.set('alpha', 'A');
    cache.set('beta', 'B');
  });

  test('C1: GET existing key returns 200 with value', async () => {
    const res = await request(app).get('/cache/alpha');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.key).toBe('alpha');
    expect(res.body.data.value).toBe('A');
  });

  test('C2: GET missing key returns 404', async () => {
    const res = await request(app).get('/cache/does-not-exist');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  test('C3: GET expired key returns 404', async () => {
    cache.set('expiring', 'bye', 60);
    expireKey(cache, 'expiring');
    const res = await request(app).get('/cache/expiring');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  test('C4: GET key after delete returns 404', async () => {
    cache.delete('alpha');
    const res = await request(app).get('/cache/alpha');
    expect(res.status).toBe(404);
  });
});

// ─── D. DELETE /cache/:key ────────────────────────────────────────────────────
describe('D. DELETE /cache/:key', () => {
  const { app, cache } = createNodeApp({ nodeId: 'n3', capacity: 10, policy: 'LRU' });
  afterAll(() => cache.stopCleanup());

  test('D1: DELETE existing key returns 200', async () => {
    cache.set('del-me', 'gone');
    const res = await request(app).delete('/cache/del-me');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('D2: key is actually removed after DELETE', async () => {
    cache.set('del-me2', 'gone');
    await request(app).delete('/cache/del-me2');
    expect(cache.get('del-me2')).toBeUndefined();
  });

  test('D3: DELETE missing key returns 404', async () => {
    const res = await request(app).delete('/cache/ghost');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  test('D4: double DELETE returns 404 on second call', async () => {
    cache.set('double', 'val');
    await request(app).delete('/cache/double');
    const res2 = await request(app).delete('/cache/double');
    expect(res2.status).toBe(404);
  });
});

// ─── E. LRU eviction ─────────────────────────────────────────────────────────
describe('E. LRU eviction via HTTP', () => {
  const { app, cache } = createNodeApp({ nodeId: 'lru-node', capacity: 3, policy: 'LRU' });
  afterAll(() => cache.stopCleanup());

  test('E1: LRU entry is evicted when capacity is exceeded', async () => {
    await request(app).put('/cache').send({ key: 'a', value: '1' });
    await request(app).put('/cache').send({ key: 'b', value: '2' });
    await request(app).put('/cache').send({ key: 'c', value: '3' });
    // 'a' is LRU; adding 'd' must evict 'a'
    await request(app).put('/cache').send({ key: 'd', value: '4' });

    const resA = await request(app).get('/cache/a');
    expect(resA.status).toBe(404); // evicted

    const resD = await request(app).get('/cache/d');
    expect(resD.status).toBe(200); // just inserted
  });

  test('E2: accessing a key promotes it above the LRU victim', async () => {
    const { app: app2, cache: cache2 } = createNodeApp({ nodeId: 'lru2', capacity: 3, policy: 'LRU' });
    try {
      await request(app2).put('/cache').send({ key: 'x', value: '1' });
      await request(app2).put('/cache').send({ key: 'y', value: '2' });
      await request(app2).put('/cache').send({ key: 'z', value: '3' });
      // touch 'x' to make 'y' the new LRU
      await request(app2).get('/cache/x');
      // Insert new key → 'y' should be evicted
      await request(app2).put('/cache').send({ key: 'w', value: '4' });

      expect((await request(app2).get('/cache/y')).status).toBe(404); // evicted
      expect((await request(app2).get('/cache/x')).status).toBe(200); // still alive
    } finally {
      cache2.stopCleanup();
    }
  });
});

// ─── F. LFU eviction ─────────────────────────────────────────────────────────
describe('F. LFU eviction via HTTP', () => {
  test('F1: least-frequently-used entry is evicted', async () => {
    const { app, cache } = createNodeApp({ nodeId: 'lfu-node', capacity: 3, policy: 'LFU' });
    try {
      await request(app).put('/cache').send({ key: 'p', value: '1' });
      await request(app).put('/cache').send({ key: 'q', value: '2' });
      await request(app).put('/cache').send({ key: 'r', value: '3' });
      // access 'q' and 'r' multiple times → 'p' remains freq=1, others freq=2+
      await request(app).get('/cache/q');
      await request(app).get('/cache/q');
      await request(app).get('/cache/r');
      // insert new key → 'p' (freq=1, LFU) should be evicted
      await request(app).put('/cache').send({ key: 's', value: '4' });

      expect((await request(app).get('/cache/p')).status).toBe(404); // evicted
      expect((await request(app).get('/cache/s')).status).toBe(200);
    } finally {
      cache.stopCleanup();
    }
  });
});

// ─── G. Independent storage ───────────────────────────────────────────────────
describe('G. Independent storage per node instance', () => {
  const { app: app1, cache: cache1 } = createNodeApp({ nodeId: 'iso-1', capacity: 10 });
  const { app: app2, cache: cache2 } = createNodeApp({ nodeId: 'iso-2', capacity: 10 });
  afterAll(() => { cache1.stopCleanup(); cache2.stopCleanup(); });

  test('G1: keys set on node-1 are not visible on node-2', async () => {
    await request(app1).put('/cache').send({ key: 'shared-key', value: 'from-node-1' });
    const res = await request(app2).get('/cache/shared-key');
    expect(res.status).toBe(404);
  });

  test('G2: keys set on node-2 are not visible on node-1', async () => {
    await request(app2).put('/cache').send({ key: 'other-key', value: 'from-node-2' });
    const res = await request(app1).get('/cache/other-key');
    expect(res.status).toBe(404);
  });

  test('G3: same key can have different values on different nodes', async () => {
    await request(app1).put('/cache').send({ key: 'dup', value: 'val-from-1' });
    await request(app2).put('/cache').send({ key: 'dup', value: 'val-from-2' });
    const r1 = await request(app1).get('/cache/dup');
    const r2 = await request(app2).get('/cache/dup');
    expect(r1.body.data.value).toBe('val-from-1');
    expect(r2.body.data.value).toBe('val-from-2');
  });
});
