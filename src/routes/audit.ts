import { NextFunction, Request, Response, Router } from 'express';
import { auditLogRepository } from '../repositories/auditLogRepository';

const router = Router();

/**
 * GET /api/audit
 * Returns recent AuditLog rows (default 50, max 200) in newest-first order.
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;
    const logs = await auditLogRepository.listRecentLogs(limit);
    res.status(200).json(logs);
  } catch (err) {
    next(err);
  }
});

export default router;

