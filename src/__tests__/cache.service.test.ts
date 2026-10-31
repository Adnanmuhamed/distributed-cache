/**
 * LRUCacheService — Automated test suite
 *
 * Uses ts-jest + fake-timer tricks: instead of real sleeps, tests that need
 * to simulate expiry manually set expiresAt to a past timestamp via the
 * overrideExpiresAt() helper (which reaches into the Map directly).
 *
 * Every test creates a FRESH LRUCacheService instance and calls
 * stopCleanup() in afterEach so the periodic timer never leaks.
 */

import { LRUCacheService } from '../services/cache.service';

// ─── Helper ──────────────────────────────────────────────────────────────────

/**
 * Reach into the private Map of the service and force-expire a key
 * without sleeping. This avoids reliance on real timers while still
 * exercising all the expiry code paths.
 */
function expireKey(service: LRUCacheService, key: string): void {
  // TypeScript private bypassed intentionally for white-box testing.
  const map: Map<string, { expiresAt: number | null }> = (service as any).map;
  const node = map.get(key);
  if (!node) throw new Error(`Key "${key}" not in map — cannot expire it.`);
  node.expiresAt = Date.now() - 1; // 1ms in the past → expired
}

/**
 * Return the ordered array of keys from MRU → LRU by walking the
 * doubly linked list directly (skipping sentinels).
 *
 * After the Milestone 5 refactor, the sentinels live inside lruPolicy.
 */
function listOrder(service: LRUCacheService): string[] {
  const lruPolicy = (service as any).lruPolicy;
  const head: { next: { key: string; next: unknown } | null } = lruPolicy.listHead;
  const tail: object = lruPolicy.listTail;
  const result: string[] = [];
  let cur: any = head.next;
  while (cur !== tail) {
    result.push(cur.key);
    cur = cur.next;
  }
  return result;
}

/**
 * Count the number of nodes in the doubly linked list (excluding sentinels).
 */
function listLength(service: LRUCacheService): number {
  return listOrder(service).length;
}

// ─── Test suite ───────────────────────────────────────────────────────────────

describe('LRUCacheService', () => {
  let cache: LRUCacheService;

  beforeEach(() => {
    cache = new LRUCacheService(5); // small capacity — easier to reason about
  });

  afterEach(() => {
    cache.stopCleanup();
  });

  // ── 1. Insert and retrieve ──────────────────────────────────────────────────
  test('1. inserts a key and retrieves its value', () => {
    cache.set('a', 'alpha');
    expect(cache.get('a')).toBe('alpha');
  });

  // ── 2. Read makes the key MRU ──────────────────────────────────────────────
  test('2. reading a key moves it to the MRU position', () => {
    cache.set('a', 'alpha');
    cache.set('b', 'beta');
    cache.set('c', 'gamma');
    // List right now (MRU→LRU): c, b, a
    cache.get('a'); // 'a' should jump to MRU
    expect(listOrder(cache)[0]).toBe('a');
  });

  // ── 3. Fill cache, LRU is evicted ─────────────────────────────────────────
  test('3. fills cache to capacity and evicts the correct LRU key', () => {
    cache.set('1', 'v1');
    cache.set('2', 'v2');
    cache.set('3', 'v3');
    cache.set('4', 'v4');
    cache.set('5', 'v5');
    // LRU is '1' (inserted first, never touched again)
    cache.set('6', 'v6'); // should evict '1'
    expect(cache.get('1')).toBeUndefined();
    expect(cache.get('6')).toBe('v6');
    expect(cache.size).toBe(5);
  });

  // ── 4. Overwrite does NOT evict an unrelated key ───────────────────────────
  test('4. overwriting an existing key while full does not evict any other key', () => {
    cache.set('1', 'v1');
    cache.set('2', 'v2');
    cache.set('3', 'v3');
    cache.set('4', 'v4');
    cache.set('5', 'v5');
    // Cache is full. Overwrite '3' — should update in-place, no eviction.
    cache.set('3', 'v3-updated');
    expect(cache.size).toBe(5);
    expect(cache.get('1')).toBe('v1');
    expect(cache.get('2')).toBe('v2');
    expect(cache.get('3')).toBe('v3-updated');
    expect(cache.get('4')).toBe('v4');
    expect(cache.get('5')).toBe('v5');
  });

  // ── 5. Delete an existing key ─────────────────────────────────────────────
  test('5. deletes an existing key and returns true', () => {
    cache.set('x', 'xray');
    expect(cache.delete('x')).toBe(true);
    expect(cache.get('x')).toBeUndefined();
  });

  // ── 6. Delete a missing key ───────────────────────────────────────────────
  test('6. deleting a missing key returns false without throwing', () => {
    expect(cache.delete('does-not-exist')).toBe(false);
  });

  // ── 7. Deleted key absent from both structures ────────────────────────────
  test('7. deleted key is absent from both the Map and the linked list', () => {
    cache.set('a', 'alpha');
    cache.set('b', 'beta');
    cache.delete('a');

    // Not in the Map.
    const map: Map<string, unknown> = (cache as any).map;
    expect(map.has('a')).toBe(false);

    // Not in the linked list.
    expect(listOrder(cache)).not.toContain('a');
  });

  // ── 8. Expired key returns undefined ─────────────────────────────────────
  test('8. an expired key is not returned', () => {
    cache.set('temp', 'value', 60); // 60s TTL
    expireKey(cache, 'temp');
    expect(cache.get('temp')).toBeUndefined();
  });

  // ── 9. Expired entries cleaned from both structures ───────────────────────
  test('9. getting an expired key removes it from both Map and linked list', () => {
    cache.set('a', 'alpha');
    cache.set('b', 'beta');
    expireKey(cache, 'a');

    cache.get('a'); // triggers removal

    const map: Map<string, unknown> = (cache as any).map;
    expect(map.has('a')).toBe(false);
    expect(listOrder(cache)).not.toContain('a');
    // 'b' still intact
    expect(cache.get('b')).toBe('beta');
  });

  // ── 10. Insertion at capacity evicts LRU valid entry ──────────────────────
  test('10. inserting at full capacity evicts the LRU valid entry', () => {
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3');
    cache.set('d', '4');
    cache.set('e', '5');
    // Touch b, c, d, e to make 'a' the LRU.
    cache.get('b');
    cache.get('c');
    cache.get('d');
    cache.get('e');
    // Insert new key — 'a' must be evicted.
    cache.set('f', '6');
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('f')).toBe('6');
  });

  // ── 11. Capacity never exceeded ───────────────────────────────────────────
  test('11. size never exceeds configured capacity after many insertions', () => {
    for (let i = 0; i < 30; i++) {
      cache.set(`key${i}`, `val${i}`);
      expect(cache.size).toBeLessThanOrEqual(5);
    }
  });

  // ── 12a. Capacity of 1 ────────────────────────────────────────────────────
  test('12a. capacity-1 cache always holds only the latest entry', () => {
    const tiny = new LRUCacheService(1);
    try {
      tiny.set('a', 'alpha');
      expect(tiny.get('a')).toBe('alpha');
      tiny.set('b', 'beta'); // evicts 'a'
      expect(tiny.get('a')).toBeUndefined();
      expect(tiny.get('b')).toBe('beta');
      expect(tiny.size).toBe(1);
    } finally {
      tiny.stopCleanup();
    }
  });

  // ── 12b. Very small capacity ──────────────────────────────────────────────
  test('12b. capacity-2 cache maintains correct LRU order', () => {
    const small = new LRUCacheService(2);
    try {
      small.set('a', '1');
      small.set('b', '2');
      small.get('a'); // 'a' becomes MRU, 'b' is LRU
      small.set('c', '3'); // should evict 'b'
      expect(small.get('b')).toBeUndefined();
      expect(small.get('a')).toBe('1');
      expect(small.get('c')).toBe('3');
    } finally {
      small.stopCleanup();
    }
  });

  // ── 13. Overwriting does not create a duplicate node ─────────────────────
  test('13. overwriting an existing key does not create a duplicate node', () => {
    cache.set('a', 'alpha');
    cache.set('b', 'beta');
    cache.set('a', 'alpha2'); // update in-place

    expect(cache.size).toBe(2);               // Map: 2 entries
    expect(listLength(cache)).toBe(2);         // List: 2 nodes (no duplicate)
    expect(listOrder(cache).filter(k => k === 'a').length).toBe(1);
    expect(cache.get('a')).toBe('alpha2');
  });

  // ── 14. Overwriting TTL semantics ────────────────────────────────────────
  test('14. overwriting a key replaces its TTL completely', () => {
    cache.set('k', 'v1', 60); // 60 s TTL
    // Now overwrite with no TTL → entry should become non-expiring.
    cache.set('k', 'v2');
    // Force the original expiry time to have passed (simulate time).
    const map: Map<string, { expiresAt: number | null }> = (cache as any).map;
    // Since we overwrote with no TTL, expiresAt must be null.
    expect(map.get('k')?.expiresAt).toBeNull();
    expect(cache.get('k')).toBe('v2');

    // Now overwrite with a new TTL.
    cache.set('k', 'v3', 120);
    expireKey(cache, 'k');
    expect(cache.get('k')).toBeUndefined();
  });

  // ── 15. Empty cache then repopulate ──────────────────────────────────────
  test('15. empty cache can be populated again correctly after all keys deleted', () => {
    cache.set('a', '1');
    cache.set('b', '2');
    cache.delete('a');
    cache.delete('b');

    expect(cache.size).toBe(0);
    expect(listLength(cache)).toBe(0);

    // Re-populate.
    cache.set('x', 'X');
    cache.set('y', 'Y');
    expect(cache.get('x')).toBe('X');
    expect(cache.get('y')).toBe('Y');
    expect(cache.size).toBe(2);
    expect(listLength(cache)).toBe(2);
  });

  // ── Bonus: expired entries freed before evicting a live entry ─────────────
  test('bonus: expired entries are purged before evicting a valid live entry', () => {
    cache.set('a', '1', 60); // will expire
    cache.set('b', '2', 60); // will expire
    cache.set('c', '3');
    cache.set('d', '4');
    cache.set('e', '5');
    // Cache is full. Expire 'a' and 'b'.
    expireKey(cache, 'a');
    expireKey(cache, 'b');
    // Insert a new key — should reclaim 'a'+'b' first, not evict 'c'/'d'/'e'.
    cache.set('f', '6');
    // After cleanup + insert: c, d, e, f alive; a and b gone.
    expect(cache.get('c')).toBe('3');
    expect(cache.get('d')).toBe('4');
    expect(cache.get('e')).toBe('5');
    expect(cache.get('f')).toBe('6');
    expect(cache.size).toBe(4);
  });

  // ── Bonus: has() respects expiry ─────────────────────────────────────────
  test('bonus: has() returns false for expired entries and removes them', () => {
    cache.set('z', 'zulu', 60);
    expireKey(cache, 'z');
    expect(cache.has('z')).toBe(false);
    const map: Map<string, unknown> = (cache as any).map;
    expect(map.has('z')).toBe(false);
    expect(listOrder(cache)).not.toContain('z');
  });
});
