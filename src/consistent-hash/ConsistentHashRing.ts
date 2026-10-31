/**
 * consistent-hash/ConsistentHashRing.ts
 *
 * Production-ready consistent hashing ring.
 *
 * Design
 * ──────
 *   • Each physical node is mapped to `virtualNodes` virtual nodes.
 *   • Each virtual node is identified by the SHA-256 hex digest of the string
 *       "<nodeId>#<replica-index>"
 *     (e.g. "cache-node-1#0", "cache-node-1#1", …).
 *   • All digests are stored in a sorted array (ring) for O(log V) lookup.
 *   • A Map<digest, nodeId> resolves digests back to physical node names.
 *   • Key lookup: hash the key → binary-search for the first ring entry ≥
 *     that hash → clockwise wraparound if past the last entry.
 *
 * Collision policy
 * ────────────────
 *   SHA-256 collisions are astronomically unlikely, but the implementation
 *   detects them deterministically and throws an error rather than silently
 *   overwriting an existing virtual node.  This makes misconfiguration
 *   immediately visible during node registration.
 *
 * Complexity
 * ──────────
 *   addNode     O(V log V)  — V insertions each O(log V) in sorted array
 *   removeNode  O(V log V)  — V binary searches + splice
 *   getNode     O(log V)    — single binary search
 *   nodeCount   O(1)
 *   nodes()     O(N)        — iterate over physicalNodes set
 *
 *   Space: O(N × V) for N physical nodes with V virtual nodes each.
 *
 * This module has NO dependency on Express, CacheService, or any other
 * application code.  It can be imported and unit-tested in isolation.
 */

import { createHash } from 'crypto';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Public view of one virtual-node entry. */
export interface VirtualNode {
  readonly hash: string;   // 64-char SHA-256 hex digest
  readonly nodeId: string; // physical node identifier
  readonly replica: number; // 0-based replica index within the physical node
}

/** Options accepted by the ConsistentHashRing constructor. */
export interface ConsistentHashRingOptions {
  /**
   * Number of virtual nodes per physical node.
   * Higher values improve key-distribution uniformity at the cost of memory.
   * Default: 100.
   */
  virtualNodes?: number;
}

// ─── Implementation ───────────────────────────────────────────────────────────

export class ConsistentHashRing {
  private readonly virtualNodes: number;

  /**
   * Sorted array of hex digests (the ring).
   * Invariant: always sorted in ascending lexicographic order.
   */
  private ring: string[] = [];

  /**
   * Maps each digest on the ring to its physical node id.
   * ring.length === hashToNode.size at all times.
   */
  private readonly hashToNode: Map<string, string> = new Map();

  /**
   * The set of registered physical node ids.
   * Used to guard against duplicate registration and to enumerate nodes.
   */
  private readonly physicalNodes: Set<string> = new Set();

  // ── Constructor ─────────────────────────────────────────────────────────────

  constructor(options: ConsistentHashRingOptions = {}) {
    const vn = options.virtualNodes ?? 100;
    if (!Number.isInteger(vn) || vn < 1) {
      throw new RangeError(`virtualNodes must be a positive integer; got ${vn}`);
    }
    this.virtualNodes = vn;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  /**
   * Register a new physical node and add its virtual nodes to the ring.
   *
   * @throws {Error} if `nodeId` is already registered.
   * @throws {Error} if a SHA-256 collision is detected (astronomically rare).
   */
  public addNode(nodeId: string): void {
    if (!nodeId || nodeId.trim() === '') {
      throw new TypeError('nodeId must be a non-empty string');
    }
    if (this.physicalNodes.has(nodeId)) {
      throw new Error(`Node "${nodeId}" is already registered in the ring`);
    }

    this.physicalNodes.add(nodeId);

    for (let i = 0; i < this.virtualNodes; i++) {
      const digest = this.computeHash(`${nodeId}#${i}`);

      // Collision guard — SHA-256 collisions are not expected, but we surface
      // them immediately rather than silently overwriting the existing mapping.
      if (this.hashToNode.has(digest)) {
        const existingNode = this.hashToNode.get(digest)!;
        throw new Error(
          `SHA-256 collision detected: digest ${digest} ` +
          `already belongs to node "${existingNode}" ` +
          `(conflict with "${nodeId}#${i}")`
        );
      }

      this.hashToNode.set(digest, nodeId);
      this.insertSorted(digest);
    }
  }

  /**
   * Remove a physical node and all its virtual nodes from the ring.
   *
   * @throws {Error} if `nodeId` is not currently registered.
   */
  public removeNode(nodeId: string): void {
    if (!this.physicalNodes.has(nodeId)) {
      throw new Error(`Node "${nodeId}" is not registered in the ring`);
    }

    this.physicalNodes.delete(nodeId);

    for (let i = 0; i < this.virtualNodes; i++) {
      const digest = this.computeHash(`${nodeId}#${i}`);
      this.hashToNode.delete(digest);
      this.removeSorted(digest);
    }
  }

  /**
   * Return the physical node responsible for `key`.
   * Uses clockwise traversal with wraparound.
   *
   * @returns The physical node id, or `null` if the ring is empty.
   */
  public getNode(key: string): string | null {
    if (this.ring.length === 0) return null;

    const digest = this.computeHash(key);
    let idx = this.lowerBound(digest);

    // Wraparound: if digest is past the last entry, use ring[0].
    if (idx >= this.ring.length) idx = 0;

    return this.hashToNode.get(this.ring[idx]) ?? null;
  }

  /**
   * Return the physical node responsible for `key`, together with the
   * matching virtual-node hash and replica index.  Useful for debugging
   * and white-box tests.
   *
   * @returns `null` if the ring is empty.
   */
  public getNodeDetails(key: string): VirtualNode | null {
    if (this.ring.length === 0) return null;

    const digest = this.computeHash(key);
    let idx = this.lowerBound(digest);
    if (idx >= this.ring.length) idx = 0;

    const vnHash = this.ring[idx];
    const nodeId = this.hashToNode.get(vnHash)!;

    // Reconstruct the replica index by re-computing hashes until we find it.
    // This is only called in tests / diagnostics so the O(V) cost is fine.
    let replica = -1;
    for (let i = 0; i < this.virtualNodes; i++) {
      if (this.computeHash(`${nodeId}#${i}`) === vnHash) {
        replica = i;
        break;
      }
    }

    return { hash: vnHash, nodeId, replica };
  }

  /** Number of physical nodes currently in the ring. */
  public get nodeCount(): number {
    return this.physicalNodes.size;
  }

  /** Number of virtual nodes currently on the ring. */
  public get virtualNodeCount(): number {
    return this.ring.length;
  }

  /** Immutable snapshot of the registered physical node ids. */
  public nodes(): string[] {
    return [...this.physicalNodes];
  }

  /** True if `nodeId` is currently registered. */
  public hasNode(nodeId: string): boolean {
    return this.physicalNodes.has(nodeId);
  }

  /**
   * Read-only view of the raw sorted ring (array of hex digests).
   * Exposed for white-box testing; do not mutate.
   */
  public getRing(): ReadonlyArray<string> {
    return this.ring;
  }

  /**
   * Compute the SHA-256 hex digest of `input`.
   * Deterministic across invocations and process restarts on the same platform.
   */
  public computeHash(input: string): string {
    return createHash('sha256').update(input, 'utf8').digest('hex');
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  /**
   * Insert `digest` into `this.ring` maintaining sorted order.
   * O(log V) binary search to find the insertion point, then O(V) splice.
   *
   * For the ring sizes used in practice (≤ tens of thousands of entries)
   * the Array.splice approach is perfectly adequate.  A skip-list or
   * balanced BST would improve insertion to O(log V) end-to-end but adds
   * significant implementation complexity for negligible real-world benefit.
   */
  private insertSorted(digest: string): void {
    const idx = this.lowerBound(digest);
    this.ring.splice(idx, 0, digest);
  }

  /**
   * Remove `digest` from `this.ring`.
   * O(log V) binary search + O(V) splice.
   */
  private removeSorted(digest: string): void {
    const idx = this.lowerBound(digest);
    if (idx < this.ring.length && this.ring[idx] === digest) {
      this.ring.splice(idx, 1);
    }
  }

  /**
   * Binary search: return the index of the first element in `this.ring`
   * that is >= `target` (standard lower_bound / bisect_left).
   * Returns `this.ring.length` if all elements are < `target`.
   */
  private lowerBound(target: string): number {
    let lo = 0;
    let hi = this.ring.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.ring[mid] < target) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return lo;
  }
}

// ─── Factory & defaults ───────────────────────────────────────────────────────

/**
 * Create and return a ConsistentHashRing pre-populated with the three default
 * physical cache nodes used by this project.
 *
 * @param virtualNodes Virtual nodes per physical node (default 100).
 */
export function makeDefaultRing(virtualNodes = 100): ConsistentHashRing {
  const ring = new ConsistentHashRing({ virtualNodes });
  ring.addNode('cache-node-1');
  ring.addNode('cache-node-2');
  ring.addNode('cache-node-3');
  return ring;
}
