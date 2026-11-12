import { NextFunction, Request, Response, Router } from 'express';
import { ordersRepository } from '../repositories/ordersRepository';

const router = Router();

/**
 * GET /api/transactions/summary
 * Returns counts and totals by status for the current month.
 * Computed strictly from stored records; never calls PayPal's Transaction Search API.
 */
router.get('/summary', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const summary = await ordersRepository.getMonthlySummary();
    res.status(200).json(summary);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/transactions
 * Returns stored Orders with status, amount, currency, captureId, createdAt.
 * Supports ?status= and ?limit= (default 50, max 100).
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = req.query.status as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;

    const orders = await ordersRepository.listOrders({ status }, limit);

    const transactions = orders.map((o) => ({
      internalId: o.internalId,
      paypalOrderId: o.paypalOrderId,
      status: o.status,
      productId: o.productId,
      quantity: o.quantity,
      amount: o.amount,
      currency: o.currency,
      captureId: o.captureId,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
    }));

    res.status(200).json(transactions);
  } catch (err) {
    next(err);
  }
});

export default router;

