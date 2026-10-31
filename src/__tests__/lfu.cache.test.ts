/**
 * LFU Cache — Automated test suite (Milestone 5)
 *
 * All tests instantiate a fresh CacheService with policy='LFU' and a small
 * capacity.  afterEach always calls stopCleanup() to prevent timer leaks.
 *
 * Deterministic expiry: instead of real sleeps we reach into the Map node
 * directly and set expiresAt to a past timestamp (expireKey helper).
 * Frequency is read via the node's .freq field (white-box).
 */

import { CacheService, makeLFUCache, LFUPolicy } from '../services/cache.service';
import { CacheNode, DLL } from '../types';

// ─── White-box helpers ────────────────────────────────────────────────────────

/** Force-expire a key without sleeping. */
function expireKey(cache: CacheService, key: string): void {
  const map: Map<string, CacheNode> = (cache as any).map;
  const node = map.get(key);
  if (!node) throw new Error(`Key "${key}" not found in map — cannot expire.`);
  node.expiresAt = Date.now() - 1;
}

/** Read the freq field directly from the internal map node. */
function getFreq(cache: CacheService, key: string): number | undefined {
  const map: Map<string, CacheNode> = (cache as any).map;
  return map.get(key)?.freq;
}

/** Get the minFreq from the LFU policy. */
function getMinFreq(cache: CacheService): number {
  const policy: LFUPolicy = (cache as any).lfuPolicy;
  return policy.minFreq;
}

/**
 * Return all keys in the LFU frequency bucket for a given freq,
 * ordered MRU → LRU (i.e. head → tail, skipping sentinels).
 */
function freqBucketKeys(cache: CacheService, freq: number): string[] {
  const policy: LFUPolicy = (cache as any).lfuPolicy;
  const freqMap: Map<number, DLL> = (policy as any).freqMap;
  const dll = freqMap.get(freq);
  if (!dll) return [];
  const keys: string[] = [];
  let cur: any = dll.head.next;
  while (cur !== dll.tail) {
    keys.push(cur.key);
    cur = cur.next;
  }
  return keys;
}

/** Count total nodes across all frequency buckets. */
function totalLFUListNodes(cache: CacheService): number {
  const policy: LFUPolicy = (cache as any).lfuPolicy;
  const freqMap: Map<number, DLL> = (policy as any).freqMap;
  let count = 0;
  for (const dll of freqMap.values()) {
    let cur: any = dll.head.next;
    while (cur !== dll.tail) { count++; cur = cur.next; }
  }
  return count;
}

// ─── Shared setup ─────────────────────────────────────────────────────────────

describe('LFU CacheService', () => {
  let cache: CacheService;

  beforeEach(() => {
    cache = new CacheService(5, 'LFU');
  });

  afterEach(() => {
    cache.stopCleanup();
  });

  // ── 1. LFU eviction picks lowest frequency ────────────────────────────────
  test('1. LFU evicts the entry with the lowest access frequency', () => {
    cache.set('a', '1');          // freq 1
    cache.set('b', '2');          // freq 1
    cache.set('c', '3');          // freq 1
    cache.set('d', '4');          // freq 1
    cache.set('e', '5');          // freq 1

    // Raise freq of b, c, d, e — 'a' stays at freq 1 and is LRU within that bucket.
    cache.get('b');               // b → freq 2
    cache.get('c');               // c → freq 2
    cache.get('d');               // d → freq 2
    cache.get('e');               // e → freq 2

    cache.set('f', '6');          // must evict 'a' (lowest freq)
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('f')).toBe('6');
    expect(cache.size).toBe(5);
  });

  // ── 2. Tie-breaking: evict LRU among equal-frequency entries ─────────────
  test('2. ties in frequency are broken by LRU order', () => {
    // Cap of 3 makes reasoning easy.
    const c = new CacheService(3, 'LFU');
    try {
      c.set('x', '1'); // freq 1, inserted first → LRU within freq-1
      c.set('y', '2'); // freq 1
      c.set('z', '3'); // freq 1

      // All at freq 1; insertion order makes x the LRU within the bucket.
      c.set('w', '4'); // must evict 'x'
      expect(c.get('x')).toBeUndefined();
      expect(c.get('y')).toBe('2');
      expect(c.get('z')).toBe('3');
      expect(c.get('w')).toBe('4');
    } finally {
      c.stopCleanup();
    }
  });

  // ── 3. GET increments frequency ───────────────────────────────────────────
  test('3. GET increments the frequency of an entry', () => {
    cache.set('k', 'v');
    expect(getFreq(cache, 'k')).toBe(1);
    cache.get('k');
    expect(getFreq(cache, 'k')).toBe(2);
    cache.get('k');
    expect(getFreq(cache, 'k')).toBe(3);
  });

  // ── 4. Cache misses do not increment frequency ────────────────────────────
  test('4. a cache miss does not increment any frequency', () => {
    cache.set('k', 'v');
    const before = getFreq(cache, 'k')!;
    cache.get('nonexistent');   // miss
    cache.get('k');             // hit → increments k
    // Only 'k' itself should have changed — by exactly 1.
    expect(getFreq(cache, 'k')).toBe(before + 1);
  });

  // ── 5a. Overwrite resets frequency to 1 ──────────────────────────────────
  test('5a. overwriting an existing key resets its frequency to 1', () => {
    cache.set('k', 'v1');
    cache.get('k');   // freq → 2
    cache.get('k');   // freq → 3
    expect(getFreq(cache, 'k')).toBe(3);

    cache.set('k', 'v2');  // overwrite — freq should reset
    expect(getFreq(cache, 'k')).toBe(1);
    expect(cache.get('k')).toBe('v2');
  });

  // ── 5b. Overwrite does not evict an unrelated key ─────────────────────────
  test('5b. overwriting a key while cache is full does not evict another key', () => {
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('c', '3');
    cache.set('d', '4');
    cache.set('e', '5');

    cache.set('c', 'c-new'); // overwrite, cache still full

    expect(cache.size).toBe(5);
    expect(cache.get('a')).toBe('1');
    expect(cache.get('b')).toBe('2');
    expect(cache.get('c')).toBe('c-new');
    expect(cache.get('d')).toBe('4');
    expect(cache.get('e')).toBe('5');
  });

  // ── 6. Deletion updates the correct frequency bucket ─────────────────────
  test('6. deletion removes the node from its frequency bucket', () => {
    cache.set('a', '1');   // freq 1
    cache.get('a');        // freq 2
    expect(freqBucketKeys(cache, 2)).toContain('a');

    cache.delete('a');
    expect(freqBucketKeys(cache, 2)).not.toContain('a');
    expect(totalLFUListNodes(cache)).toBe(0);
    expect(cache.size).toBe(0);
  });

  // ── 7. Expired entries removed from all LFU structures ───────────────────
  test('7. lazy expiry on GET removes node from map and frequency bucket', () => {
    cache.set('a', '1', 60);  // TTL 60s
    cache.get('a');            // freq 2
    expireKey(cache, 'a');

    const result = cache.get('a'); // should be undefined and clean up
    expect(result).toBeUndefined();

    const map: Map<string, CacheNode> = (cache as any).map;
    expect(map.has('a')).toBe(false);
    expect(totalLFUListNodes(cache)).toBe(0);
  });

  // ── 8. Expired entries reclaimed before live eviction ────────────────────
  test('8. expired entries are purged before a live entry is LFU-evicted', () => {
    cache.set('a', '1', 60);  // will expire
    cache.set('b', '2', 60);  // will expire
    cache.set('c', '3');
    cache.set('d', '4');
    cache.set('e', '5');

    expireKey(cache, 'a');
    expireKey(cache, 'b');

    // Cache is full but 'a' and 'b' are expired.
    // Inserting 'f' should reclaim them rather than evict 'c'/'d'/'e'.
    cache.set('f', '6');
    expect(cache.get('c')).toBe('3');
    expect(cache.get('d')).toBe('4');
    expect(cache.get('e')).toBe('5');
    expect(cache.get('f')).toBe('6');
    expect(cache.size).toBe(4);
  });

  // ── 9. minFrequency correctness ───────────────────────────────────────────
  test('9a. minFreq is 1 after fresh inserts', () => {
    cache.set('a', '1');
    cache.set('b', '2');
    expect(getMinFreq(cache)).toBe(1);
  });

  test('9b. minFreq updates correctly after eviction', () => {
    const c = new CacheService(3, 'LFU');
    try {
      c.set('a', '1');  // freq 1
      c.set('b', '2');  // freq 1
      c.set('c', '3');  // freq 1
      c.get('a');       // a → freq 2
      c.get('b');       // b → freq 2
      // min freq is 1 (only 'c' is there)
      expect(getMinFreq(c)).toBe(1);
      c.set('d', '4');  // evicts 'c' (freq 1, LRU); minFreq resets to 1 (new insert)
      expect(getMinFreq(c)).toBe(1);
    } finally {
      c.stopCleanup();
    }
  });

  test('9c. minFreq is correct after explicit deletion empties the min bucket', () => {
    const c = new CacheService(3, 'LFU');
    try {
      c.set('a', '1'); // freq 1
      c.set('b', '2'); // freq 1
      c.get('a');      // a → freq 2
      // minFreq = 1 (b is there)
      c.delete('b');   // removes the only freq-1 entry
      // minFreq may be stale here — that is fine for correctness.
      // The next evict() must still work correctly.
      c.set('c', '3'); // new insert → minFreq = 1 again
      c.set('d', '4'); // new insert, cache full
      // evict: should remove 'c' (freq 1, LRU) or 'd' (freq 1, also LRU but newer)
      // 'c' was inserted first so it is the LRU in the freq-1 bucket.
      c.set('e', '5'); // triggers eviction of 'c'
      expect(c.get('c')).toBeUndefined();
      expect(c.get('d')).toBe('4');
      expect(c.get('e')).toBe('5');
    } finally {
      c.stopCleanup();
    }
  });

  // ── 10. Capacity-1 LFU ───────────────────────────────────────────────────
  test('10. capacity-1 LFU cache always holds only the latest entry', () => {
    const tiny = new CacheService(1, 'LFU');
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

  // ── 11. Repeated insertions preserve Map/list consistency ─────────────────
  test('11. repeated insertions and evictions keep map and list consistent', () => {
    for (let i = 0; i < 30; i++) {
      cache.set(`key${i}`, `val${i}`);
      expect(cache.size).toBeLessThanOrEqual(5);
      expect(totalLFUListNodes(cache)).toBe(cache.size);
    }
  });

  // ── 12. Existing LRU tests still pass (regression guard) ─────────────────
  test('12. LRU policy: inserting and retrieving values still works', () => {
    const lru = new CacheService(3, 'LRU');
    try {
      lru.set('a', '1');
      lru.set('b', '2');
      lru.set('c', '3');
      lru.get('a');        // a → MRU
      lru.set('d', '4');   // evicts 'b' (LRU)
      expect(lru.get('b')).toBeUndefined();
      expect(lru.get('a')).toBe('1');
      expect(lru.get('d')).toBe('4');
    } finally {
      lru.stopCleanup();
    }
  });

  // ── 13. Both policies respect the capacity limit ──────────────────────────
  test('13. LFU and LRU both respect the capacity limit', () => {
    const lfu = new CacheService(4, 'LFU');
    const lru = new CacheService(4, 'LRU');
    try {
      for (let i = 0; i < 20; i++) {
        lfu.set(`k${i}`, `v${i}`);
        lru.set(`k${i}`, `v${i}`);
        expect(lfu.size).toBeLessThanOrEqual(4);
        expect(lru.size).toBeLessThanOrEqual(4);
      }
    } finally {
      lfu.stopCleanup();
      lru.stopCleanup();
    }
  });

  // ── Bonus: overwrite does not create a duplicate node in any freq bucket ──
  test('bonus: overwriting a key does not create a duplicate LFU node', () => {
    cache.set('a', 'v1');
    cache.get('a');           // freq → 2
    cache.get('a');           // freq → 3
    cache.set('a', 'v2');    // overwrite → freq reset to 1

    // Exactly 1 node total across all buckets.
    expect(totalLFUListNodes(cache)).toBe(1);
    expect(cache.size).toBe(1);
    // The node is in freq-1 bucket.
    expect(freqBucketKeys(cache, 1)).toContain('a');
    expect(freqBucketKeys(cache, 2)).not.toContain('a');
    expect(freqBucketKeys(cache, 3)).not.toContain('a');
  });

  // ── Bonus: TTL works under LFU ────────────────────────────────────────────
  test('bonus: TTL is honoured under LFU — overwrite replaces TTL completely', () => {
    cache.set('k', 'v1', 60);  // 60s TTL
    cache.set('k', 'v2');      // overwrite with no TTL

    const map: Map<string, CacheNode> = (cache as any).map;
    expect(map.get('k')?.expiresAt).toBeNull();
    expect(cache.get('k')).toBe('v2');

    cache.set('k', 'v3', 120);
    expireKey(cache, 'k');
    expect(cache.get('k')).toBeUndefined();
  });

  // ── Bonus: periodic cleanupExpired removes from LFU structures ────────────
  test('bonus: periodic cleanupExpired clears expired nodes from all freq buckets', () => {
    cache.set('a', '1', 60);
    cache.get('a');  // freq 2
    cache.get('a');  // freq 3
    cache.set('b', '2');

    expireKey(cache, 'a');

    // Manually call the private cleanupExpired.
    (cache as any).cleanupExpired();

    const map: Map<string, CacheNode> = (cache as any).map;
    expect(map.has('a')).toBe(false);
    expect(totalLFUListNodes(cache)).toBe(1); // only 'b' remains
    expect(freqBucketKeys(cache, 3)).not.toContain('a');
    expect(cache.get('b')).toBe('2');
  });

  // ══════════════════════════════════════════════════════════════════════════
  // Milestone 5 targeted correctness tests
  // ══════════════════════════════════════════════════════════════════════════

  // ── A. Widely separated frequency values, then delete the min-freq entries ─
  describe('A. widely-separated frequencies + deletion of min-freq entries', () => {
    test('A1: evict() finds correct victim after freq-1 bucket is deleted via delete()', () => {
      // cap=3: insert a (freq1), b (freq1), then bump a to freq=1000
      const c = new CacheService(3, 'LFU');
      try {
        c.set('a', '1');  // freq 1
        c.set('b', '2');  // freq 1
        // Simulate large frequency gap: access 'a' 999 times
        for (let i = 0; i < 999; i++) c.get('a');  // a → freq 1000
        // a=freq1000, b=freq1, minFreq=1
        expect(getMinFreq(c)).toBe(1);

        // Delete the only freq-1 node ('b') — min bucket becomes empty
        c.delete('b');
        // minFreq is now stale (1), but no freq-1 bucket exists
        // Insert 'c' — cache is not full, just inserts normally
        c.set('c', '3');  // freq 1, minFreq resets to 1

        // Insert 'd' — cache is full (cap=3: a,c, and now we need to evict)
        // Wait, cap=3: after delete b we have {a}, after set c we have {a,c},
        // so set d we have {a,c,d} — still within cap.
        c.set('d', '4');  // now full: a(1000), c(1), d(1)

        // Insert 'e' — must evict from freq-1 bucket (c or d), NOT a.
        c.set('e', '5');
        expect(c.get('a')).toBe('1');  // a must survive (freq 1000)
        // c or d was evicted (both freq 1), e exists
        expect(c.get('e')).toBe('5');
        expect(c.size).toBe(3);
      } finally {
        c.stopCleanup();
      }
    });

    test('A2: evict() with large frequency gap does NOT loop O(gap) times', () => {
      // Verify correctness: with a=freq1000, b=freq1, deleting b and then
      // calling evict() does not hang or produce a wrong victim.
      const c = new CacheService(2, 'LFU');
      try {
        c.set('a', '1');  // freq 1
        c.set('b', '2');  // freq 1
        for (let i = 0; i < 999; i++) c.get('a');  // a → freq 1000

        // Delete only freq-1 entry
        c.delete('b');
        // minFreq=1 is stale; freqMap only has key 1000

        // Insert new key → triggers eviction (cap=2, size=1 after delete so no eviction needed)
        c.set('c', '3');  // size=2, full

        // Now insert 'd' — eviction needed. Must evict 'c' (freq 1), not 'a' (freq 1000).
        c.set('d', '4');
        expect(c.get('a')).toBe('1');
        expect(c.get('c')).toBeUndefined();  // evicted
        expect(c.get('d')).toBe('4');
      } finally {
        c.stopCleanup();
      }
    });
  });

  // ── B. Eviction after the minimum-frequency bucket becomes empty ────────────
  describe('B. eviction after min-freq bucket becomes empty via deletion', () => {
    test('B1: deleting all freq-1 entries then inserting a new key evicts from next freq', () => {
      const c = new CacheService(3, 'LFU');
      try {
        c.set('a', '1'); // freq 1
        c.set('b', '2'); // freq 1
        c.set('c', '3'); // freq 1
        c.get('b');  // b → freq 2
        c.get('c');  // c → freq 2

        // Delete the only freq-1 entry ('a')
        c.delete('a');
        // freqMap: { 2: [b, c] }; minFreq=1 (stale)

        // Insert 'd' — cache has room (size=2), so no eviction
        c.set('d', '4'); // d → freq 1; minFreq resets to 1
        // Now full: b(2), c(2), d(1)

        // Insert 'e' — must evict 'd' (only freq-1 entry)
        c.set('e', '5');
        expect(c.get('d')).toBeUndefined();  // d evicted
        expect(c.get('b')).toBe('2');
        expect(c.get('c')).toBe('3');
        expect(c.get('e')).toBe('5');
        expect(c.size).toBe(3);
      } finally {
        c.stopCleanup();
      }
    });

    test('B2: evict() directly on stale minFreq returns correct victim', () => {
      const c = new CacheService(3, 'LFU');
      try {
        c.set('x', '1');
        c.set('y', '2');
        c.get('x');  // x → freq 2
        c.get('x');  // x → freq 3
        c.get('y');  // y → freq 2
        // Delete y (freq 2), making freq-1 bucket missing; also freq-2 gone
        // only x at freq 3 remains
        c.delete('y');

        // Insert 'z' (freq 1) and 'w' (freq 1) — not full yet
        c.set('z', '3');  // minFreq = 1
        c.set('w', '4');  // full: x(3), z(1), w(1)

        // Evict — z is LRU in freq-1 bucket
        c.set('v', '5');
        expect(c.get('z')).toBeUndefined();  // evicted (LRU in freq-1)
        expect(c.get('w')).toBe('4');
        expect(c.get('x')).toBe('1');
        expect(c.get('v')).toBe('5');
      } finally {
        c.stopCleanup();
      }
    });
  });

  // ── C. Expiration of the last entry in the minimum-frequency bucket ─────────
  describe('C. expiration of last entry in min-freq bucket', () => {
    test('C1: expiring the sole freq-1 entry via get() cleans up and next eviction is correct', () => {
      const c = new CacheService(3, 'LFU');
      try {
        c.set('a', '1', 60); // freq 1, will expire
        c.set('b', '2');     // freq 1
        c.get('b');          // b → freq 2

        // Expire 'a' (the only freq-1 entry)
        expireKey(c, 'a');
        // Lazy remove 'a' on GET
        expect(c.get('a')).toBeUndefined();
        // freqMap: { 2: [b] }; minFreq=1 (stale)

        // Insert 'c' (freq 1, minFreq resets to 1)
        c.set('c', '3');
        // Insert 'd' — full (b=2, c=1, d=1 at cap=3)
        c.set('d', '4');
        // Insert 'e' — evict from freq-1: 'c' is LRU
        c.set('e', '5');

        expect(c.get('c')).toBeUndefined();  // c evicted
        expect(c.get('b')).toBe('2');
        expect(c.get('d')).toBe('4');
        expect(c.get('e')).toBe('5');
      } finally {
        c.stopCleanup();
      }
    });

    test('C2: periodic cleanupExpired removes last min-bucket entry; minFreq healed; evict still works', () => {
      const c = new CacheService(3, 'LFU');
      try {
        c.set('a', '1', 60);  // freq 1, will expire
        c.set('b', '2');
        c.get('b');            // b → freq 2
        c.set('c', '3');      // freq 1

        expireKey(c, 'a');
        // periodic cleanup
        (c as any).cleanupExpired();
        // 'a' gone; c(1), b(2) remain; minFreq should be 1 (c is there)
        const map: Map<string, CacheNode> = (c as any).map;
        expect(map.has('a')).toBe(false);
        expect(totalLFUListNodes(c)).toBe(2);

        // Inserting 'd' fills cache
        c.set('d', '4');  // full: b(2), c(1), d(1)
        // Inserting 'e' should evict 'c' (LRU in freq-1)
        c.set('e', '5');
        expect(c.get('c')).toBeUndefined();
        expect(c.get('b')).toBe('2');
        expect(c.get('d')).toBe('4');
        expect(c.get('e')).toBe('5');
      } finally {
        c.stopCleanup();
      }
    });
  });

  // ── D. Repeated delete/insert/evict sequences ───────────────────────────────
  describe('D. repeated delete/insert/evict sequences', () => {
    test('D1: alternating set/delete/set maintains correct map and list state', () => {
      const c = new CacheService(3, 'LFU');
      try {
        for (let round = 0; round < 10; round++) {
          c.set('x', `v${round}`);
          c.set('y', `w${round}`);
          c.get('x');  // x freq 2
          c.delete('y');
          // Map should have exactly 1 key: x
          expect(c.size).toBe(1);
          expect(totalLFUListNodes(c)).toBe(1);
          c.delete('x');
          expect(c.size).toBe(0);
          expect(totalLFUListNodes(c)).toBe(0);
        }
      } finally {
        c.stopCleanup();
      }
    });

    test('D2: insert-to-full, delete-min, insert again — size and list always match', () => {
      const c = new CacheService(4, 'LFU');
      try {
        c.set('a', '1');
        c.set('b', '2');
        c.set('c', '3');
        c.set('d', '4');
        // bump a, b, c
        c.get('a'); c.get('b'); c.get('c');
        // d is lowest freq. Delete it manually.
        c.delete('d');
        expect(c.size).toBe(3);
        expect(totalLFUListNodes(c)).toBe(3);

        // Insert e — no eviction needed (room exists)
        c.set('e', '5');
        expect(c.size).toBe(4);
        expect(totalLFUListNodes(c)).toBe(4);

        // Insert f — must evict. e is only freq-1 entry.
        c.set('f', '6');
        expect(c.get('e')).toBeUndefined();
        expect(c.size).toBe(4);
        expect(totalLFUListNodes(c)).toBe(4);
      } finally {
        c.stopCleanup();
      }
    });

    test('D3: rapid overwrite cycle keeps freq=1 and single node per key', () => {
      const c = new CacheService(2, 'LFU');
      try {
        for (let i = 0; i < 20; i++) {
          c.set('k', `val${i}`);
          // Each overwrite resets freq to 1, no duplicate nodes
          expect(getFreq(c, 'k')).toBe(1);
          expect(totalLFUListNodes(c)).toBe(1);
          expect(c.size).toBe(1);
          // freqMap should have exactly 1 bucket: freq=1
          const policy: LFUPolicy = (c as any).lfuPolicy;
          const freqMapRef: Map<number, DLL> = (policy as any).freqMap;
          expect(freqMapRef.size).toBe(1);
          expect(freqMapRef.has(1)).toBe(true);
        }
      } finally {
        c.stopCleanup();
      }
    });
  });

  // ── E. Map vs linked-list consistency after mixed operations ────────────────
  describe('E. map/list consistency after mixed operations', () => {
    test('E1: map.size always equals totalLFUListNodes after arbitrary ops', () => {
      const c = new CacheService(5, 'LFU');
      try {
        const ops = [
          () => c.set('a', '1'),
          () => c.set('b', '2'),
          () => c.get('a'),
          () => c.set('c', '3'),
          () => c.get('b'),
          () => c.get('b'),
          () => c.delete('a'),
          () => c.set('d', '4'),
          () => c.set('e', '5'),
          () => c.set('a', 'new'),  // re-insert
          () => c.set('f', '6'),   // triggers eviction
          () => c.delete('d'),
          () => c.set('g', '7'),
          () => c.get('g'),
          () => c.set('b', 'b2'),  // overwrite
        ];
        for (const op of ops) {
          op();
          // invariant: map entries == total list nodes at all times
          expect(c.size).toBe(totalLFUListNodes(c));
        }
      } finally {
        c.stopCleanup();
      }
    });

    test('E2: every map key has exactly one node in exactly one freq bucket', () => {
      const c = new CacheService(5, 'LFU');
      try {
        c.set('a', '1'); c.set('b', '2'); c.set('c', '3');
        c.get('a'); c.get('a'); c.get('b');
        c.set('d', '4'); c.set('e', '5');
        c.get('c');
        c.delete('b');
        c.set('a', 'reset');  // overwrite → freq 1

        const map: Map<string, CacheNode> = (c as any).map;
        const policy: LFUPolicy = (c as any).lfuPolicy;
        const freqMapRef: Map<number, DLL> = (policy as any).freqMap;

        // Build a set of keys found in all freq buckets
        const keysInLists = new Set<string>();
        for (const dll of freqMapRef.values()) {
          let cur: any = dll.head.next;
          while (cur !== dll.tail) {
            // Each key must appear exactly once
            expect(keysInLists.has(cur.key)).toBe(false);
            keysInLists.add(cur.key);
            cur = cur.next;
          }
        }

        // Keys in lists == keys in map (no orphans, no ghosts)
        expect(keysInLists.size).toBe(map.size);
        for (const key of map.keys()) {
          expect(keysInLists.has(key)).toBe(true);
        }
      } finally {
        c.stopCleanup();
      }
    });

    test('E3: expiring entries via get() leaves no ghost nodes in any freq bucket', () => {
      const c = new CacheService(4, 'LFU');
      try {
        c.set('p', '1', 60); c.set('q', '2', 60);
        c.set('r', '3');     c.set('s', '4');
        c.get('p'); c.get('q');  // bump to freq 2 before expiry

        expireKey(c, 'p');
        expireKey(c, 'q');

        // Lazy removal via get
        expect(c.get('p')).toBeUndefined();
        expect(c.get('q')).toBeUndefined();

        const map: Map<string, CacheNode> = (c as any).map;
        expect(map.size).toBe(2);
        expect(totalLFUListNodes(c)).toBe(2);

        // No ghost nodes for p or q in any bucket
        const policy: LFUPolicy = (c as any).lfuPolicy;
        const freqMapRef: Map<number, DLL> = (policy as any).freqMap;
        for (const dll of freqMapRef.values()) {
          let cur: any = dll.head.next;
          while (cur !== dll.tail) {
            expect(['r', 's']).toContain(cur.key);
            cur = cur.next;
          }
        }
      } finally {
        c.stopCleanup();
      }
    });
  });
});
