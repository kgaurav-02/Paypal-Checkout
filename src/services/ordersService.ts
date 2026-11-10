import { env } from '../config/env';
import { getProductById } from '../data/products';
import {
  CaptureFailureError,
  OrderNotApprovedError,
  ProductNotFoundError,
} from '../errors/paypalErrors';
import { evaluateOrder } from './approvalPolicy';
import * as paypalClient from './paypalClient';

export interface CreateOrderInput {
  productId: string;
  quantity: number;
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
 * If approval is required, returns approval_required status without calling PayPal.
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

  const paypalOrder = await paypalClient.createOrder({
    amount: formattedAmount,
    currency: product.currency,
    description,
  });

  return {
    orderId: paypalOrder.orderId,
    status: paypalOrder.status,
  };
}

/**
 * Captures an approved PayPal order.
 * Validates that the order has been approved prior to capture,
 * and verifies that PayPal returned COMPLETED status.
 */
export async function captureOrder(orderId: string): Promise<CaptureOrderOutput> {
  // Step 1: Verify the order status with PayPal before attempting capture
  const orderDetails = await paypalClient.getOrder(orderId);

  if (orderDetails.status !== 'APPROVED') {
    throw new OrderNotApprovedError(
      `Order ${orderId} has status "${orderDetails.status}". An order must be APPROVED before capture.`
    );
  }

  // Step 2: Request PayPal to capture the funds
  const captureResult = await paypalClient.captureOrder(orderId);

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
