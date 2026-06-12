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
