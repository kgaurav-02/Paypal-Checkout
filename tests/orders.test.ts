import { randomUUID } from 'crypto';
import http from 'http';
import { AddressInfo } from 'net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import app from '../src/app';
import { env } from '../src/config/env';
import { PayPalUnavailableError } from '../src/errors/paypalErrors';
import * as paypalClient from '../src/services/paypalClient';

describe('Orders API Routes (Payment Safety & Reconciliation)', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    // Prevent environment proxy settings from intercepting local test traffic
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    process.env.NO_PROXY = '*';

    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('GET /api/config (Public Configuration)', () => {
    it('returns only public configuration and never leaks client secret', async () => {
      const res = await fetch(`${baseUrl}/api/config`);
      expect(res.status).toBe(200);

      const data = (await res.json()) as Record<string, unknown>;
      expect(data).toEqual({
        paypalClientId: env.PAYPAL_CLIENT_ID,
        currency: 'USD',
        maxAmount: env.MAX_AMOUNT,
      });

      expect(data.paypalClientSecret).toBeUndefined();
      expect(data.clientSecret).toBeUndefined();
      expect(JSON.stringify(data)).not.toContain(env.PAYPAL_CLIENT_SECRET);
    });
  });

  describe('POST /api/orders (Order Creation & Idempotency)', () => {
    it('rejects missing checkoutAttemptId with 400 VALIDATION_ERROR', async () => {
      const res = await fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: 'demo-headphones',
          quantity: 1,
        }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data).toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          message: expect.stringContaining('checkoutAttemptId'),
        },
      });
    });

    it('rejects non-UUID checkoutAttemptId with 400 VALIDATION_ERROR', async () => {
      const res = await fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: 'demo-headphones',
          quantity: 1,
          checkoutAttemptId: 'not-a-valid-uuid',
        }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data).toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          message: expect.stringContaining('valid UUID'),
        },
      });
    });

    it('rejects missing productId with 400 VALIDATION_ERROR', async () => {
      const res = await fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          quantity: 1,
          checkoutAttemptId: randomUUID(),
        }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data).toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          message: expect.stringContaining('productId'),
        },
      });
    });

    it('rejects quantity < 1 with 400 VALIDATION_ERROR', async () => {
      const res = await fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: 'demo-headphones',
          quantity: 0,
          checkoutAttemptId: randomUUID(),
        }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data).toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          message: expect.stringContaining('quantity'),
        },
      });
    });

    it('rejects quantity > 10 with 400 VALIDATION_ERROR', async () => {
      const res = await fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: 'demo-headphones',
          quantity: 11,
          checkoutAttemptId: randomUUID(),
        }),
      });

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data).toEqual({
        error: {
          code: 'VALIDATION_ERROR',
          message: expect.stringContaining('quantity'),
        },
      });
    });

    it('ensures two identical create attempts send the same idempotency requestId header', async () => {
      const createOrderSpy = vi.spyOn(paypalClient, 'createOrder').mockResolvedValue({
        orderId: 'MOCK_ORDER_IDEMPOTENT',
        status: 'CREATED',
      });

      const attemptId = 'a1b2c3d4-e5f6-4a1b-8c2d-3e4f5a6b7c8d';

      // First attempt
      const res1 = await fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: 'demo-headphones',
          quantity: 1,
          checkoutAttemptId: attemptId,
        }),
      });
      expect(res1.status).toBe(201);

      // Second retry attempt with the exact same checkoutAttemptId
      const res2 = await fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: 'demo-headphones',
          quantity: 1,
          checkoutAttemptId: attemptId,
        }),
      });
      expect(res2.status).toBe(201);

      // Both attempts must pass the exact same requestId to the PayPal client
      expect(createOrderSpy).toHaveBeenCalledTimes(2);
      expect(createOrderSpy.mock.calls[0][0].requestId).toBe(attemptId);
      expect(createOrderSpy.mock.calls[1][0].requestId).toBe(attemptId);
    });

    it('uses catalog price (49.99) and creates order when amount <= MAX_AMOUNT', async () => {
      const attemptId = randomUUID();
      const createOrderSpy = vi.spyOn(paypalClient, 'createOrder').mockResolvedValue({
        orderId: 'MOCK_ORDER_123',
        status: 'CREATED',
      });

      const res = await fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: 'demo-headphones',
          quantity: 2, // 49.99 * 2 = 99.98 <= 100
          price: 1.0, // Ignored
          amount: '0.01', // Ignored
          checkoutAttemptId: attemptId,
        }),
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data).toEqual({
        orderId: 'MOCK_ORDER_123',
        status: 'CREATED',
      });

      expect(createOrderSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          amount: '99.98',
          currency: 'USD',
          description: expect.stringContaining('Demo Wireless Headphones'),
          requestId: attemptId,
        })
      );
    });

    it('returns HTTP 202 approval_required when amount > MAX_AMOUNT and never calls PayPal', async () => {
      const createOrderSpy = vi.spyOn(paypalClient, 'createOrder');

      // 49.99 * 3 = 149.97 > 100 (MAX_AMOUNT)
      const res = await fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: 'demo-headphones',
          quantity: 3,
          checkoutAttemptId: randomUUID(),
        }),
      });

      expect(res.status).toBe(202);
      const data = await res.json();
      expect(data).toEqual({
        status: 'approval_required',
        reason: expect.stringContaining('exceeds the automated approval limit'),
      });

      // Assert that PayPal was NEVER called
      expect(createOrderSpy).not.toHaveBeenCalled();
    });

    it('rejects product not in catalog with 404 PRODUCT_NOT_FOUND', async () => {
      const res = await fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: 'non-existent-item',
          quantity: 1,
          checkoutAttemptId: randomUUID(),
        }),
      });

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data).toEqual({
        error: {
          code: 'PRODUCT_NOT_FOUND',
          message: 'Product not found: non-existent-item',
        },
      });
    });

    it('returns 503 PAYPAL_UNAVAILABLE when PayPal service fails or times out', async () => {
      vi.spyOn(paypalClient, 'createOrder').mockRejectedValue(
        new PayPalUnavailableError('PayPal request timed out. Please try again.')
      );

      const res = await fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: 'demo-headphones',
          quantity: 1,
          checkoutAttemptId: randomUUID(),
        }),
      });

      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data).toEqual({
        error: {
          code: 'PAYPAL_UNAVAILABLE',
          message: 'PayPal request timed out. Please try again.',
        },
      });
    });
  });

  describe('POST /api/orders/:id/capture (Capture Verification & Timeout Reconciliation)', () => {
    it('returns 409 ORDER_NOT_APPROVED when order status is not APPROVED', async () => {
      vi.spyOn(paypalClient, 'getOrder').mockResolvedValue({
        id: 'ORDER_PENDING_APPROVAL',
        status: 'CREATED', // Not yet approved by buyer
        intent: 'CAPTURE',
      });

      const captureSpy = vi.spyOn(paypalClient, 'captureOrder');

      const res = await fetch(`${baseUrl}/api/orders/ORDER_PENDING_APPROVAL/capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data).toEqual({
        error: {
          code: 'ORDER_NOT_APPROVED',
          message: expect.stringContaining('must be APPROVED before capture'),
        },
      });

      // Crucial: captureOrder must NOT be called if order is not approved
      expect(captureSpy).not.toHaveBeenCalled();
    });

    it('returns COMPLETED verified capture when PayPal responds with COMPLETED', async () => {
      vi.spyOn(paypalClient, 'getOrder').mockResolvedValue({
        id: 'ORDER_APPROVED_123',
        status: 'APPROVED',
        intent: 'CAPTURE',
      });

      vi.spyOn(paypalClient, 'captureOrder').mockResolvedValue({
        id: 'ORDER_APPROVED_123',
        status: 'COMPLETED',
        purchase_units: [
          {
            payments: {
              captures: [
                {
                  id: 'CAPTURE_TRANSACTION_999',
                  status: 'COMPLETED',
                  amount: {
                    value: '49.99',
                    currency_code: 'USD',
                  },
                },
              ],
            },
          },
        ],
      });

      const res = await fetch(`${baseUrl}/api/orders/ORDER_APPROVED_123/capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({
        orderId: 'ORDER_APPROVED_123',
        status: 'COMPLETED',
        captureId: 'CAPTURE_TRANSACTION_999',
        amount: '49.99',
        currency: 'USD',
      });
    });

    it('reconciles capture on timeout: returns verified capture result if order status is COMPLETED', async () => {
      const orderId = 'ORDER_RECONCILE_SUCCESS';

      // First getOrder call: pre-capture verification shows APPROVED
      // Second getOrder call: reconciliation after timeout shows COMPLETED
      const getOrderSpy = vi
        .spyOn(paypalClient, 'getOrder')
        .mockResolvedValueOnce({
          id: orderId,
          status: 'APPROVED',
          intent: 'CAPTURE',
        })
        .mockResolvedValueOnce({
          id: orderId,
          status: 'COMPLETED',
          intent: 'CAPTURE',
          purchase_units: [
            {
              payments: {
                captures: [
                  {
                    id: 'CAPTURE_RECONCILED_888',
                    status: 'COMPLETED',
                    amount: {
                      value: '49.99',
                      currency_code: 'USD',
                    },
                  },
                ],
              },
            },
          ],
        });

      // Capture request throws timeout / network error
      vi.spyOn(paypalClient, 'captureOrder').mockRejectedValue(
        new PayPalUnavailableError('PayPal Capture Order service timed out.')
      );

      const res = await fetch(`${baseUrl}/api/orders/${orderId}/capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      // Should recover and return verified capture result (HTTP 200), not a false 503
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toEqual({
        orderId: orderId,
        status: 'COMPLETED',
        captureId: 'CAPTURE_RECONCILED_888',
        amount: '49.99',
        currency: 'USD',
      });

      expect(getOrderSpy).toHaveBeenCalledTimes(2);
    });

    it('returns 503 if capture times out and reconciliation confirms order is NOT COMPLETED', async () => {
      const orderId = 'ORDER_RECONCILE_FAILED';

      vi.spyOn(paypalClient, 'getOrder')
        .mockResolvedValueOnce({
          id: orderId,
          status: 'APPROVED',
          intent: 'CAPTURE',
        })
        .mockResolvedValueOnce({
          id: orderId,
          status: 'APPROVED', // Still APPROVED, capture did not complete on PayPal
          intent: 'CAPTURE',
        });

      vi.spyOn(paypalClient, 'captureOrder').mockRejectedValue(
        new PayPalUnavailableError('PayPal Capture Order service timed out.')
      );

      const res = await fetch(`${baseUrl}/api/orders/${orderId}/capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data).toEqual({
        error: {
          code: 'PAYPAL_UNAVAILABLE',
          message: 'PayPal Capture Order service timed out.',
        },
      });
    });

    it('rejects with 422 CAPTURE_FAILED if PayPal capture returns non-COMPLETED status', async () => {
      vi.spyOn(paypalClient, 'getOrder').mockResolvedValue({
        id: 'ORDER_FAILED_CAPTURE',
        status: 'APPROVED',
        intent: 'CAPTURE',
      });

      vi.spyOn(paypalClient, 'captureOrder').mockResolvedValue({
        id: 'ORDER_FAILED_CAPTURE',
        status: 'FAILED',
      });

      const res = await fetch(`${baseUrl}/api/orders/ORDER_FAILED_CAPTURE/capture`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });

      expect(res.status).toBe(422);
      const data = await res.json();
      expect(data).toEqual({
        error: {
          code: 'CAPTURE_FAILED',
          message: expect.stringMatching(/completed/i),
        },
      });
    });
  });
});
