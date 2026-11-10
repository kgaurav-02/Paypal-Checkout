import { env } from '../config/env';
import { getProductById } from '../data/products';
import {
  CaptureFailureError,
  OrderNotApprovedError,
  PayPalUnavailableError,
  ProductNotFoundError,
} from '../errors/paypalErrors';
import { evaluateOrder } from './approvalPolicy';
import * as paypalClient from './paypalClient';

export interface CreateOrderInput {
  productId: string;
  quantity: number;
  checkoutAttemptId: string;
}

export type CreateOrderOutput =
  | {
      status: 'approval_required';
      reason: string;
    }
  | {
      orderId: string;
      status: string;
    };

export interface CaptureOrderOutput {
  orderId: string;
  status: 'COMPLETED';
  captureId: string;
  amount: string;
  currency: string;
}

/**
 * Creates an order using server-authoritative product catalog pricing.
 * Checks server-side approval policy before calling PayPal.
 * Reuses checkoutAttemptId as the idempotency key so retries do not create duplicate orders.
 */
export async function createOrder(input: CreateOrderInput): Promise<CreateOrderOutput> {
  const product = getProductById(input.productId);
  if (!product) {
    throw new ProductNotFoundError(input.productId);
  }

  // Authoritative server-side price calculation
  const totalAmount = Math.round(product.price * input.quantity * 100) / 100;

  // Evaluate server-side approval policy
  const policy = evaluateOrder(totalAmount, env.MAX_AMOUNT);
  if (policy.decision === 'approval_required') {
    return {
      status: 'approval_required',
      reason: policy.reason,
    };
  }

  const formattedAmount = totalAmount.toFixed(2);
  const description = `${product.name} (Qty: ${input.quantity})`;

  // Pass client-supplied checkoutAttemptId as requestId for idempotency across retries
  const paypalOrder = await paypalClient.createOrder({
    amount: formattedAmount,
    currency: product.currency,
    description,
    requestId: input.checkoutAttemptId,
  });

  return {
    orderId: paypalOrder.orderId,
    status: paypalOrder.status,
  };
}

/**
 * Captures an approved PayPal order.
 *
 * Payment Safety:
 * 1. Checks approval status prior to capture (must be APPROVED).
 * 2. Uses a stable idempotency key derived from the order ID ("capture-" + orderId).
 * 3. Reconciles timeouts/network errors via GET /v2/checkout/orders/{id}: if the order
 *    was actually completed despite the network drop, returns verified capture result
 *    instead of a false 503 error.
 */
export async function captureOrder(orderId: string): Promise<CaptureOrderOutput> {
  // Step 1: Verify the order status with PayPal before attempting capture
  const orderDetails = await paypalClient.getOrder(orderId);

  if (orderDetails.status !== 'APPROVED') {
    throw new OrderNotApprovedError(
      `Order ${orderId} has status "${orderDetails.status}". An order must be APPROVED before capture.`
    );
  }

  // Step 2: Request PayPal to capture the funds using a stable idempotency key
  const requestId = `capture-${orderId}`;
  let captureResult: paypalClient.PayPalCaptureResult;

  try {
    captureResult = await paypalClient.captureOrder(orderId, requestId);
  } catch (err: unknown) {
    // Capture timeout reconciliation: if capture request times out or returns network error,
    // do NOT return 503 immediately. Check if PayPal actually processed the capture.
    if (err instanceof PayPalUnavailableError) {
      console.warn(
        `[Capture Reconciliation] Capture request timed out or failed for order ${orderId}. Reconciling order status...`
      );
      try {
        const reconciledOrder = await paypalClient.getOrder(orderId);
        if (reconciledOrder.status === 'COMPLETED') {
          console.log(
            `[Capture Reconciliation] Order ${orderId} was verified COMPLETED on PayPal.`
          );
          const captureObj = reconciledOrder.purchase_units?.[0]?.payments?.captures?.[0];
          return {
            orderId,
            status: 'COMPLETED',
            captureId: captureObj?.id || '',
            amount: captureObj?.amount?.value || '',
            currency: captureObj?.amount?.currency_code || 'USD',
          };
        }
      } catch (reconcileErr) {
        console.error(
          `[Capture Reconciliation] Reconciliation check failed for order ${orderId}:`,
          reconcileErr
        );
      }

      // If the order is not COMPLETED or status check fails, return the 503 error
      throw err;
    }
    throw err;
  }

  // Step 3: Verify the capture status is COMPLETED
  if (captureResult.status !== 'COMPLETED') {
    throw new CaptureFailureError(
      `Capture was not completed by PayPal. Current status: ${captureResult.status}`
    );
  }

  const captureObj = captureResult.purchase_units?.[0]?.payments?.captures?.[0];
  const captureId = captureObj?.id || '';
  const amount = captureObj?.amount?.value || '';
  const currency = captureObj?.amount?.currency_code || 'USD';

  return {
    orderId,
    status: 'COMPLETED',
    captureId,
    amount,
    currency,
  };
}
