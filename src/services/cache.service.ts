import { CacheNode, DLL, EvictionPolicy } from '../types';

// ═══════════════════════════════════════════════════════════════════════════════
// Shared DLL helpers (used by both LRU and LFU)
// ═══════════════════════════════════════════════════════════════════════════════

/** Create a sentinel-pair DLL (head ↔ tail, nothing in between). */
function makeDLL(): DLL {
  const head = makeSentinel('__H__');
  const tail = makeSentinel('__T__');
  head.next = tail;
  tail.prev = head;
  return { head, tail };
}

function makeSentinel(key: string): CacheNode {
  return { key, value: '', expiresAt: null, lastAccessedAt: 0, prev: null, next: null };
}

/** Detach a node from whatever list it is currently in. O(1). */
function removeNode(node: CacheNode): void {
  const p = node.prev!;
  const n = node.next!;
  p.next = n;
  n.prev = p;
  node.prev = null;
  node.next = null;
}

/** Insert `node` at the MRU end (immediately after `head`). O(1). */
function insertAtMRU(dll: DLL, node: CacheNode): void {
  const after = dll.head.next!;
  dll.head.next = node;
  node.prev = dll.head;
  node.next = after;
  after.prev = node;
}

/** True iff the DLL has no real nodes (only sentinels). */
function isDLLEmpty(dll: DLL): boolean {
  return dll.head.next === dll.tail;
}

function isExpired(node: CacheNode): boolean {
  return node.expiresAt !== null && Date.now() > node.expiresAt;
}

// ═══════════════════════════════════════════════════════════════════════════════
// LRU eviction policy
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * LRU policy — O(1) average time.
 *
 * A single doubly linked list: head.next = MRU, tail.prev = LRU.
 * Sentinel nodes eliminate all null-check edge cases.
 *
 * Complexity:
 *   onAccess / onInsert  O(1) — pointer splices only
 *   onEvict              O(1) — tail.prev gives LRU directly
 *   onDelete             O(1)
 *   cleanupExpired       O(n) — full scan, called periodically / before eviction
 */
class LRUPolicy {
  private readonly dll: DLL;

  constructor() {
    this.dll = makeDLL();
  }

  onInsert(node: CacheNode): void {
    insertAtMRU(this.dll, node);
  }

  onAccess(node: CacheNode): void {
    removeNode(node);
    insertAtMRU(this.dll, node);
  }

  onDelete(node: CacheNode): void {
    removeNode(node);
  }

  /** Evict the LRU node; return it so the caller can remove it from the Map. */
  evict(): CacheNode | null {
    const lru = this.dll.tail.prev!;
    if (lru === this.dll.head) return null;
    removeNode(lru);
    return lru;
  }

  /** Scan and remove all expired nodes. Returns number removed. O(n). */
  cleanupExpired(map: Map<string, CacheNode>): number {
    let count = 0;
    let cur = this.dll.head.next!;
    while (cur !== this.dll.tail) {
      const next = cur.next!;
      if (isExpired(cur)) {
        removeNode(cur);
        map.delete(cur.key);
        count++;
      }
      cur = next;
    }
    return count;
  }

  /** Expose the single DLL for white-box testing (head sentinel). */
  get listHead(): CacheNode { return this.dll.head; }
  get listTail(): CacheNode { return this.dll.tail; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LFU eviction policy
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * LFU policy — O(1) average time (amortized).
 *
 * Data structures:
 *   freqMap: Map<freq, DLL>
 *     One sentinel-pair DLL per distinct access-frequency value.
 *     Within each DLL, nodes are ordered MRU→LRU (head→tail).
 *     Tie-breaking: the LRU node within the lowest-frequency bucket
 *     is evicted first.
 *
 *   minFreq: number
 *     The minimum occupied frequency. Maintained exactly:
 *       • After onInsert  → minFreq = 1
 *       • After onAccess  → minFreq = old freq + 1 *only if* the old
 *         bucket becomes empty and minFreq == old freq
 *       • After onDelete  → minFreq may become stale if we deleted the
 *         last node in the min bucket. The next evict() call repairs
 *         it in O(F) by scanning freqMap.keys() (NOT by linear ++,
 *         which would be O(gap) when frequency values have large gaps).
 *       • After evict     → same stale/repair path as onDelete
 *
 * Frequency policy on overwrite (set of existing key):
 *   Frequency is RESET TO 1.
 *   Rationale: the entry's value is replaced completely. Treating it
 *   as a new entry avoids "phantom recency" from accumulated historical
 *   accesses that no longer reflect the current value. This is the
 *   most common production choice and is documented here explicitly.
 *
 * Complexity:
 *   onInsert   O(1)
 *   onAccess   O(1)
 *   onDelete   O(1)  — node removal; if the min bucket becomes empty,
 *                      minFreq is left stale (fixed lazily in evict)
 *   evict      O(F)  — O(F) freqMap key scan only when minFreq is stale
 *                      (after deletions or expiration); O(1) common case.
 *                      F = distinct frequency buckets ≤ capacity, so this
 *                      is bounded by capacity, not by the gap in freq values.
 *   cleanupExpired O(n) — full scan across all n nodes in all buckets.
 *                      After cleanup, minFreq is repaired in O(F).
 *
 * *** Important: set() for a new key when the cache is full calls
 * cleanupExpired() first. That path is O(n) over ALL live nodes,
 * regardless of how many entries are actually expired, because every
 * node must be visited to check its TTL. Do not document this as O(k)
 * where k=expired count. set() for an existing key and all gets/deletes
 * are O(1). ***
 */
class LFUPolicy {
  /** freq → DLL of nodes at that frequency. */
  private readonly freqMap: Map<number, DLL>;
  private _minFreq: number;

  constructor() {
    this.freqMap = new Map();
    this._minFreq = 0;
  }

  get minFreq(): number { return this._minFreq; }

  /** Ensure a bucket for `freq` exists; return it. */
  private bucket(freq: number): DLL {
    let dll = this.freqMap.get(freq);
    if (!dll) {
      dll = makeDLL();
      this.freqMap.set(freq, dll);
    }
    return dll;
  }

  /**
   * Called when a brand-new node is inserted (freq already set to 1 by caller).
   */
  onInsert(node: CacheNode): void {
    node.freq = 1;
    insertAtMRU(this.bucket(1), node);
    this._minFreq = 1;
  }

  /**
   * Called on a successful GET. Moves node from freq bucket to freq+1 bucket.
   * O(1).
   */
  onAccess(node: CacheNode): void {
    const oldFreq = node.freq!;
    removeNode(node);

    // If the old bucket is now empty and it was the min, raise minFreq.
    if (isDLLEmpty(this.bucket(oldFreq)) && this._minFreq === oldFreq) {
      this._minFreq = oldFreq + 1;
      this.freqMap.delete(oldFreq); // trim empty buckets eagerly
    } else if (isDLLEmpty(this.bucket(oldFreq))) {
      this.freqMap.delete(oldFreq);
    }

    node.freq = oldFreq + 1;
    insertAtMRU(this.bucket(node.freq), node);
  }

  /**
   * Called when a key is explicitly deleted or lazily expired.
   * O(1).
   */
  onDelete(node: CacheNode): void {
    const freq = node.freq!;
    removeNode(node);
    const bkt = this.freqMap.get(freq);
    if (bkt && isDLLEmpty(bkt)) {
      this.freqMap.delete(freq);
      // If we deleted from the min-freq bucket and it is now empty,
      // minFreq becomes stale. We DON'T scan to find the new min here
      // (that would be O(n)). Instead we let it remain stale; the next
      // eviction will find it via the freqMap naturally because evict()
      // advances until it finds a non-empty bucket. This preserves O(1)
      // for delete at the cost of a minor minFreq inaccuracy that has no
      // correctness impact — evict() handles it explicitly.
    }
  }

  /**
   * Evict the LRU entry at the minimum frequency.
   * Returns the evicted node, or null if the policy has no nodes.
   *
   * O(1) in the common case (minFreq is accurate).
   * O(F) when minFreq is stale after a deletion or expiration, where
   * F = number of distinct frequency buckets (≤ capacity).  We scan
   * freqMap.keys() rather than incrementing minFreq one-by-one, which
   * avoids O(gap) behaviour when frequency values have large gaps
   * (e.g. a key at freq=1 and another at freq=1 000 000).
   */
  evict(): CacheNode | null {
    // Fast path: minFreq is still valid.
    const fastBkt = this.freqMap.get(this._minFreq);
    if (!fastBkt || isDLLEmpty(fastBkt)) {
      // minFreq is stale — clean up the invalid bucket and find the real min
      // by scanning freqMap.keys().  This is O(F) ≤ O(capacity).
      if (fastBkt) this.freqMap.delete(this._minFreq);

      if (this.freqMap.size === 0) {
        this._minFreq = 0;
        return null;
      }

      let newMin = Infinity;
      for (const f of this.freqMap.keys()) {
        if (f < newMin) newMin = f;
      }
      this._minFreq = newMin;
    }

    const bkt = this.freqMap.get(this._minFreq);
    if (!bkt || isDLLEmpty(bkt)) return null;

    // LRU within the bucket = the node just before tail.
    const victim = bkt.tail.prev!;
    if (victim === bkt.head) return null;
    removeNode(victim);
    if (isDLLEmpty(bkt)) this.freqMap.delete(this._minFreq);
    return victim;
  }

  /**
   * Remove all expired nodes from all frequency buckets.
   * O(n) where n is total number of live nodes.
   */
  cleanupExpired(map: Map<string, CacheNode>): number {
    let count = 0;
    for (const [freq, dll] of this.freqMap) {
      let cur = dll.head.next!;
      while (cur !== dll.tail) {
        const next = cur.next!;
        if (isExpired(cur)) {
          removeNode(cur);
          map.delete(cur.key);
          count++;
        }
        cur = next;
      }
      if (isDLLEmpty(dll)) this.freqMap.delete(freq);
    }
    // After cleanup, minFreq may be stale. Revalidate cheaply.
    if (this._minFreq > 0 && !this.freqMap.has(this._minFreq)) {
      // Find lowest remaining key (O(freqMap.size), not O(n entries)).
      let newMin = Infinity;
      for (const f of this.freqMap.keys()) {
        if (f < newMin) newMin = f;
      }
      this._minFreq = isFinite(newMin) ? newMin : 0;
    }
    return count;
  }

  /** Expose freqMap for white-box testing. */
  get freqMapRef(): Map<number, DLL> { return this.freqMap; }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Unified CacheService (Strategy pattern)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * CacheService — unified cache backed by a configurable eviction policy.
 *
 * Defaults to LRU (capacity 100) so all existing behaviour is preserved.
 *
 * Architecture:
 *   • this.map          — Map<string, CacheNode>   O(1) key→node lookup
 *   • this.lruPolicy    — LRUPolicy (active when policy === 'LRU')
 *   • this.lfuPolicy    — LFUPolicy (active when policy === 'LFU')
 *   • cleanupInterval   — periodic expiry sweep; unref()'d to allow clean exit
 *
 * The Map and the timer are owned here. Eviction-order decisions are
 * delegated entirely to the active policy object.
 *
 * ──────────────────────────────────────────────────────────────────
 * Complexity summary (both policies)
 * ──────────────────────────────────────────────────────────────────
 *  get               O(1)   — Map lookup + policy.onAccess
 *  set (update)      O(1)   — Map lookup + policy.onDelete + policy.onInsert
 *  set (new, room)   O(1)
 *  set (new, full)   O(n)   — calls cleanupExpired which scans ALL n live
 *                             nodes to check TTL, then O(1) eviction if still
 *                             full.  Cannot be tightened to O(k) because every
 *                             node must be visited regardless of expiry count.
 *  delete            O(1)
 *  evict  (LRU)      O(1)   — tail.prev
 *  evict  (LFU)      O(F)   — freqMap key scan when minFreq is stale;
 *                             F = distinct freq buckets ≤ capacity; O(1) common
 *  cleanupExpired    O(n)   — periodic, runs every 30 s
 * ──────────────────────────────────────────────────────────────────
 */
class CacheService {
  private readonly map: Map<string, CacheNode>;
  private readonly lruPolicy: LRUPolicy;
  private readonly lfuPolicy: LFUPolicy;
  private readonly policy: EvictionPolicy;
  private cleanupInterval: NodeJS.Timeout;
  private readonly capacity: number;

  constructor(capacity = 100, policy: EvictionPolicy = 'LRU') {
    if (capacity < 1) throw new RangeError('capacity must be >= 1');
    this.capacity = capacity;
    this.policy = policy;
    this.map = new Map();
    this.lruPolicy = new LRUPolicy();
    this.lfuPolicy = new LFUPolicy();

    this.cleanupInterval = setInterval(() => this.cleanupExpired(), 30_000);
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────────

  /**
   * Insert or overwrite a cache entry.
   *
   * TTL semantics (same for both policies):
   *   The new ttl completely replaces any previous TTL.
   *   Omitting ttl makes the entry non-expiring.
   *
   * Frequency semantics on overwrite (LFU):
   *   Frequency is RESET TO 1 — see LFUPolicy header for rationale.
   *
   * Eviction order when cache is full:
   *   1. Expired entries are purged first (O(k) where k = expired count).
   *   2. If still full, the active policy evicts one live entry (O(1)).
   */
  public set(key: string, value: string, ttl?: number): void {
    const now = Date.now();
    const expiresAt = ttl !== undefined ? now + ttl * 1_000 : null;

    const existing = this.map.get(key);
    if (existing !== undefined) {
      // Update in-place: no capacity check, no eviction of unrelated keys.
      // Remove from current position in the eviction structure first.
      if (this.policy === 'LRU') {
        existing.value = value;
        existing.expiresAt = expiresAt;
        existing.lastAccessedAt = now;
        this.lruPolicy.onAccess(existing); // move to MRU
      } else {
        // LFU: reset frequency — remove from old bucket, re-insert at freq 1.
        this.lfuPolicy.onDelete(existing);
        existing.value = value;
        existing.expiresAt = expiresAt;
        existing.lastAccessedAt = now;
        this.lfuPolicy.onInsert(existing); // freq reset to 1, minFreq = 1
      }
      return;
    }

    // New key — ensure room.
    if (this.map.size >= this.capacity) {
      this.cleanupExpired();
      if (this.map.size >= this.capacity) {
        this.evictOne();
      }
    }

    const node: CacheNode = {
      key,
      value,
      expiresAt,
      lastAccessedAt: now,
      prev: null,
      next: null,
    };

    if (this.policy === 'LRU') {
      this.lruPolicy.onInsert(node);
    } else {
      this.lfuPolicy.onInsert(node); // sets node.freq = 1
    }
    this.map.set(key, node);
  }

  /**
   * Retrieve a value by key.
   * Returns undefined for misses and expired entries.
   * On a hit: moves the node to MRU (LRU) or increments its freq (LFU).
   */
  public get(key: string): string | undefined {
    const node = this.map.get(key);
    if (node === undefined) return undefined;

    if (isExpired(node)) {
      if (this.policy === 'LRU') {
        this.lruPolicy.onDelete(node);
      } else {
        this.lfuPolicy.onDelete(node);
      }
      this.map.delete(key);
      return undefined;
    }

    node.lastAccessedAt = Date.now();
    if (this.policy === 'LRU') {
      this.lruPolicy.onAccess(node);
    } else {
      this.lfuPolicy.onAccess(node);
    }
    return node.value;
  }

  /**
   * Delete a key. Returns true if the key existed, false otherwise.
   */
  public delete(key: string): boolean {
    const node = this.map.get(key);
    if (node === undefined) return false;
    if (this.policy === 'LRU') {
      this.lruPolicy.onDelete(node);
    } else {
      this.lfuPolicy.onDelete(node);
    }
    this.map.delete(key);
    return true;
  }

  /**
   * Returns true if the key exists and has not expired.
   */
  public has(key: string): boolean {
    const node = this.map.get(key);
    if (node === undefined) return false;
    if (isExpired(node)) {
      if (this.policy === 'LRU') {
        this.lruPolicy.onDelete(node);
      } else {
        this.lfuPolicy.onDelete(node);
      }
      this.map.delete(key);
      return false;
    }
    return true;
  }

  /** Stop the periodic cleanup timer (tests / graceful shutdown). */
  public stopCleanup(): void {
    clearInterval(this.cleanupInterval);
  }

  /** Live entry count (may include not-yet-purged expired entries). */
  public get size(): number {
    return this.map.size;
  }

  // ──────────────────────────────────────────────────────────────────
  // Private
  // ──────────────────────────────────────────────────────────────────

  private evictOne(): void {
    const victim =
      this.policy === 'LRU' ? this.lruPolicy.evict() : this.lfuPolicy.evict();
    if (victim !== null) {
      this.map.delete(victim.key);
      console.log(`[${this.policy}] Evicted key: ${victim.key}`);
    }
  }

  private cleanupExpired(): void {
    const count =
      this.policy === 'LRU'
        ? this.lruPolicy.cleanupExpired(this.map)
        : this.lfuPolicy.cleanupExpired(this.map);
    if (count > 0) {
      console.log(`[Cache Cleanup] Removed ${count} expired key(s).`);
    }
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────

/** Default singleton — LRU, capacity 100. Behaviour is identical to Milestone 4. */
export const cacheService = new CacheService();

/**
 * Export the unified class under both names so existing tests that import
 * `LRUCacheService` continue to compile and run without modification.
 *
 * LRUCacheService === CacheService (LRU policy is the default).
 */
export { CacheService as LRUCacheService, CacheService };

/**
 * Convenience factory for an LFU-policy cache.
 * Used in tests; can also be wired to a different route in the future.
 */
export function makeLFUCache(capacity: number): CacheService {
  return new CacheService(capacity, 'LFU');
}

// Re-export policy types used by LRU policy internals so tests can peek.
export { LRUPolicy, LFUPolicy };
