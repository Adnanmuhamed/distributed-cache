import { CacheEntry } from '../types';

class CacheService {
  private cache: Map<string, CacheEntry>;
  private cleanupInterval: NodeJS.Timeout;
  private readonly capacity = 100;

  constructor() {
    this.cache = new Map<string, CacheEntry>();
    // Run cleanup every 30 seconds
    this.cleanupInterval = setInterval(() => this.cleanupExpired(), 30000);
  }

  public set(key: string, value: string, ttl?: number): void {
    const now = Date.now();
    const expiresAt = ttl !== undefined ? now + ttl * 1000 : null;

    if (!this.cache.has(key) && this.cache.size >= this.capacity) {
      this.evictLRU();
    }

    this.cache.set(key, { value, expiresAt, lastAccessedAt: now });
  }

  public get(key: string): string | undefined {
    const entry = this.cache.get(key);
    if (!entry) {
      return undefined;
    }

    const now = Date.now();
    if (entry.expiresAt !== null && now > entry.expiresAt) {
      this.cache.delete(key);
      return undefined;
    }

    entry.lastAccessedAt = now;
    return entry.value;
  }

  public delete(key: string): boolean {
    return this.cache.delete(key);
  }

  public has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;

    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestAccessTime = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.lastAccessedAt < oldestAccessTime) {
        oldestAccessTime = entry.lastAccessedAt;
        oldestKey = key;
      }
    }

    if (oldestKey !== null) {
      this.cache.delete(oldestKey);
      console.log(`[LRU] Evicted key: ${oldestKey}`);
    }
  }

  private cleanupExpired(): void {
    const now = Date.now();
    let count = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt !== null && now > entry.expiresAt) {
        this.cache.delete(key);
        count++;
      }
    }
    if (count > 0) {
      console.log(`[Cache Cleanup] Removed ${count} expired keys.`);
    }
  }

  public stopCleanup(): void {
    clearInterval(this.cleanupInterval);
  }
}

export const cacheService = new CacheService();
