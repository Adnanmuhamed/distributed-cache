import { Router, Request, Response } from 'express';
import { cacheService } from '../services/cache.service';
import { SetCacheRequest } from '../types';

const router = Router();

// PUT /cache
router.put('/', (req: Request, res: Response) => {
  const { key, value, ttl } = req.body as SetCacheRequest;

  if (key === undefined || typeof key !== 'string' || value === undefined || typeof value !== 'string') {
    return res.status(400).json({
      success: false,
      message: 'Invalid request body. "key" and "value" must be strings.',
    });
  }

  if (ttl !== undefined && typeof ttl !== 'number') {
    return res.status(400).json({
      success: false,
      message: 'Invalid request body. "ttl" must be a number.',
    });
  }

  cacheService.set(key, value, ttl);

  return res.status(200).json({
    success: true,
    message: 'Cache entry stored successfully.',
  });
});

// GET /cache/:key
router.get('/:key', (req: Request, res: Response) => {
  const { key } = req.params;

  const value = cacheService.get(key);

  if (value === undefined) {
    return res.status(404).json({
      success: false,
      message: 'Cache entry not found or expired.',
    });
  }

  return res.status(200).json({
    success: true,
    data: { key, value },
  });
});

// DELETE /cache/:key
router.delete('/:key', (req: Request, res: Response) => {
  const { key } = req.params;

  const deleted = cacheService.delete(key);

  if (!deleted) {
    return res.status(404).json({
      success: false,
      message: 'Cache entry not found.',
    });
  }

  return res.status(200).json({
    success: true,
    message: 'Cache entry deleted successfully.',
  });
});

export default router;
