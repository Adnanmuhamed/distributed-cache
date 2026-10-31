/**
 * types/index.ts
 *
 * Shared node type used by both LRU and LFU implementations.
 * All pointer fields (prev/next) are used by the doubly linked lists
 * inside each eviction policy.
 */

/** Eviction policies supported by the cache service. */
export type EvictionPolicy = 'LRU' | 'LFU';

/**
 * A node shared by both LRU and LFU implementations.
 *
 * LRU uses:  key, value, expiresAt, lastAccessedAt, prev, next
 * LFU adds:  freq  (access frequency counter)
 *
 * Using one interface keeps the Map<string, CacheNode> type-clean
 * without requiring separate per-policy node types.
 */
export interface CacheNode {
  key: string;
  value: string;
  /** Unix ms after which this entry is expired, or null for no expiry. */
  expiresAt: number | null;
  /** Unix ms of the most recent read (get) or write (set). Diagnostic only. */
  lastAccessedAt: number;
  /** Doubly-linked-list prev pointer. */
  prev: CacheNode | null;
  /** Doubly-linked-list next pointer. */
  next: CacheNode | null;
  /**
   * LFU only: how many times this node has been accessed.
   * Undefined / ignored under LRU.
   */
  freq?: number;
}

/**
 * A sentinel-pair doubly linked list used by both policies.
 * head.next = MRU end, tail.prev = LRU end.
 */
export interface DLL {
  head: CacheNode;
  tail: CacheNode;
}

// ─── Legacy / public-facing types (unchanged) ────────────────────────────────

/**
 * LRUNode kept as a type alias so existing test helpers that import it
 * by name continue to compile without changes.
 */
export type LRUNode = CacheNode;

/**
 * CacheEntry retained for backward compatibility with external consumers.
 * Not used internally.
 */
export interface CacheEntry {
  value: string;
  expiresAt: number | null;
  lastAccessedAt: number;
}

export interface SetCacheRequest {
  key: string;
  value: string;
  ttl?: number;
}

export interface CacheResponse {
  success: boolean;
  message?: string;
  data?: any;
}
