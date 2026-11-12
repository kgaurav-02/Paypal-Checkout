import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { ValidationError } from '../errors/paypalErrors';
import * as ordersService from '../services/ordersService';

const router = Router();

const createOrderSchema = z.object({
  productId: z
    .string({
      required_error: 'productId is required',
      invalid_type_error: 'productId must be a string',
    })
    .min(1, 'productId cannot be empty'),
  quantity: z
    .number({
      required_error: 'quantity is required',
      invalid_type_error: 'quantity must be a number',
    })
    .int('quantity must be an integer')
    .min(1, 'quantity must be between 1 and 10')
    .max(10, 'quantity must be between 1 and 10'),
  checkoutAttemptId: z
    .string({
      required_error: 'checkoutAttemptId is required',
      invalid_type_error: 'checkoutAttemptId must be a string',
    })
    .uuid('checkoutAttemptId must be a valid UUID'),
  orderInternalId: z.string().optional(),
  approvalRequestId: z.string().optional(),
});

const captureParamsSchema = z.object({
  id: z
    .string({
      required_error: 'Order ID is required',
      invalid_type_error: 'Order ID must be a string',
    })
    .min(1, 'Order ID cannot be empty'),
});

/**
 * POST /api/orders
 * Creates a PayPal Orders v2 order with intent CAPTURE.
 * Evaluates server-side approval policy before calling PayPal.
 * Reuses client-supplied checkoutAttemptId as the idempotency key so retries do not duplicate orders.
 */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parseResult = createOrderSchema.safeParse(req.body);
    if (!parseResult.success) {
      const issue = parseResult.error.issues[0];
      throw new ValidationError(issue.message);
    }

    const { productId, quantity, checkoutAttemptId, orderInternalId, approvalRequestId } = parseResult.data;
    const result = await ordersService.createOrder({
      productId,
      quantity,
      checkoutAttemptId,
      orderInternalId,
      approvalRequestId,
    });

    if (result.status === 'approval_required') {
      res.status(202).json(result);
      return;
    }

    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/orders/:id/capture
 * Captures an approved PayPal order.
 * Reconciles with PayPal upon network or timeout errors to avoid false 503s on captured orders.
 */
router.post('/:id/capture', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parseResult = captureParamsSchema.safeParse(req.params);
    if (!parseResult.success) {
      const issue = parseResult.error.issues[0];
      throw new ValidationError(issue.message);
    }

    const orderId = parseResult.data.id;
    const captureResult = await ordersService.captureOrder(orderId);

    res.status(200).json(captureResult);
  } catch (err) {
    next(err);
  }
});

export default router;
