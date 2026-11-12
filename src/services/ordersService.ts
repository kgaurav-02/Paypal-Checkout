import { randomUUID } from 'crypto';
import { env } from '../config/env';
import { getProductById } from '../data/products';
import {
  CaptureFailureError,
  OrderNotApprovedError,
  OrderRejectedError,
  PayPalUnavailableError,
  ProductNotFoundError,
} from '../errors/paypalErrors';
import { approvalRequestsRepository } from '../repositories/approvalRequestsRepository';
import { auditLogRepository } from '../repositories/auditLogRepository';
import { financialPolicyRepository } from '../repositories/financialPolicyRepository';
import { ordersRepository } from '../repositories/ordersRepository';
import { riskAssessmentRepository } from '../repositories/riskAssessmentRepository';
import { evaluateOrder } from './approvalPolicy';
import { evaluateRisk } from './fraudShield/score';
import * as paypalClient from './paypalClient';

export interface CreateOrderInput {
  productId: string;
  quantity: number;
  checkoutAttemptId: string;
  orderInternalId?: string;
  approvalRequestId?: string;
}

export type CreateOrderOutput =
  | {
      status: 'approval_required';
      approvalRequestId: string;
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
 * Persists the order in MongoDB with status CREATED after PayPal returns.
 */
export async function createOrder(input: CreateOrderInput): Promise<CreateOrderOutput> {
  // Check if an existing order is referenced by orderInternalId, approvalRequestId, or checkoutAttemptId
  let existingOrder = null;

  if (input.orderInternalId) {
    existingOrder = await ordersRepository.findOrderByInternalId(input.orderInternalId);
  }

  if (!existingOrder && input.approvalRequestId) {
    const existingReq = await approvalRequestsRepository.findById(input.approvalRequestId);
    if (existingReq) {
      existingOrder = await ordersRepository.findOrderByInternalId(existingReq.orderInternalId);
    }
  }

  if (!existingOrder && input.checkoutAttemptId) {
    existingOrder = await ordersRepository.findOrderByInternalId(input.checkoutAttemptId);
  }

  if (existingOrder) {
    if (existingOrder.status === 'REJECTED') {
      throw new OrderRejectedError('Order approval was rejected. Order creation is blocked.');
    }

    if (existingOrder.status === 'PENDING_APPROVAL') {
      const existingReq = await approvalRequestsRepository.findByOrderInternalId(
        existingOrder.internalId
      );
      return {
        status: 'approval_required',
        approvalRequestId: existingReq ? existingReq.internalId : '',
        reason: existingReq ? existingReq.reason : 'Order requires administrative approval.',
      };
    }

    // Check if this order was approved and already has a PayPal order created.
    // If so, return it idempotently and never create a duplicate PayPal order or stored order.
    const associatedApproval = await approvalRequestsRepository.findByOrderInternalId(
      existingOrder.internalId
    );
    if (
      associatedApproval &&
      associatedApproval.status === 'APPROVED' &&
      existingOrder.paypalOrderId
    ) {
      return {
        orderId: existingOrder.paypalOrderId,
        status: existingOrder.status,
      };
    }
  }

  const isApprovedOrder = Boolean(existingOrder && existingOrder.status === 'APPROVED');

  const productId = isApprovedOrder ? existingOrder!.productId : input.productId;
  const product = getProductById(productId);
  if (!product) {
    throw new ProductNotFoundError(productId);
  }

  const quantityToCharge = isApprovedOrder ? existingOrder!.quantity : input.quantity;
  const totalAmount = isApprovedOrder
    ? existingOrder!.amount
    : Math.round(product.price * input.quantity * 100) / 100;
  const currencyToCharge = isApprovedOrder ? existingOrder!.currency : product.currency;
  const targetInternalId = isApprovedOrder ? existingOrder!.internalId : input.checkoutAttemptId;

  // If not previously approved by human, evaluate active financial policy and FraudShield risk
  if (!isApprovedOrder) {
    const activePolicy = await financialPolicyRepository.getActivePolicy();
    const maxAllowed = activePolicy ? activePolicy.requiresApprovalAbove : env.MAX_AMOUNT;
    const policy = evaluateOrder(totalAmount, maxAllowed);

    if (policy.decision === 'approval_required') {
      // Save order with status PENDING_APPROVAL and no PayPal call
      await ordersRepository.saveOrder({
        internalId: targetInternalId,
        status: 'PENDING_APPROVAL',
        productId: product.id,
        quantity: quantityToCharge,
        amount: totalAmount,
        currency: currencyToCharge,
      });

      // Run FraudShield assessment on stored order
      const history = await ordersRepository.listOrders({}, 100);
      const risk = evaluateRisk(
        {
          internalId: targetInternalId,
          amount: totalAmount,
          currency: currencyToCharge,
          createdAt: new Date(),
        },
        history.map((h) => ({
          internalId: h.internalId,
          amount: h.amount,
          currency: h.currency,
          status: h.status,
          createdAt: h.createdAt,
        }))
      );
      await riskAssessmentRepository.saveAssessment({
        orderInternalId: targetInternalId,
        score: risk.score,
        classification: risk.classification,
        reasons: risk.reasons,
        recommendedAction: risk.recommendedAction,
      });

      const approvalRequestId = randomUUID();
      await approvalRequestsRepository.createApprovalRequest({
        internalId: approvalRequestId,
        orderInternalId: targetInternalId,
        amount: totalAmount,
        currency: currencyToCharge,
        reason: policy.reason,
      });

      await auditLogRepository.recordLog({
        action: 'ORDER_PENDING_APPROVAL',
        actor: 'SYSTEM',
        entityType: 'Order',
        entityId: targetInternalId,
        details: {
          approvalRequestId,
          amount: totalAmount,
          currency: currencyToCharge,
          threshold: maxAllowed,
          reason: policy.reason,
          riskScore: risk.score,
          riskClassification: risk.classification,
        },
      });

      return {
        status: 'approval_required',
        approvalRequestId,
        reason: policy.reason,
      };
    }

    // Evaluate FraudShield risk for orders below financial policy threshold
    const history = await ordersRepository.listOrders({}, 100);
    const risk = evaluateRisk(
      {
        internalId: targetInternalId,
        amount: totalAmount,
        currency: currencyToCharge,
        createdAt: new Date(),
      },
      history.map((h) => ({
        internalId: h.internalId,
        amount: h.amount,
        currency: h.currency,
        status: h.status,
        createdAt: h.createdAt,
      }))
    );

    // Save risk assessment
    await riskAssessmentRepository.saveAssessment({
      orderInternalId: targetInternalId,
      score: risk.score,
      classification: risk.classification,
      reasons: risk.reasons,
      recommendedAction: risk.recommendedAction,
    });

    // High or Critical risk score routes through Guardian ApprovalRequest
    if (risk.classification === 'HIGH' || risk.classification === 'CRITICAL') {
      await ordersRepository.saveOrder({
        internalId: targetInternalId,
        status: 'PENDING_APPROVAL',
        productId: product.id,
        quantity: quantityToCharge,
        amount: totalAmount,
        currency: currencyToCharge,
      });

      const approvalRequestId = randomUUID();
      const reason = `FraudShield elevated risk score: ${risk.score}/100 (${
        risk.classification
      }). Rules triggered: ${risk.reasons.map((r) => r.rule).join(', ')}. Administrative review required.`;

      await approvalRequestsRepository.createApprovalRequest({
        internalId: approvalRequestId,
        orderInternalId: targetInternalId,
        amount: totalAmount,
        currency: currencyToCharge,
        reason,
      });

      await auditLogRepository.recordLog({
        action: 'RISK_ASSESSMENT_HIGH_RISK_GATED',
        actor: 'FRAUD_SHIELD',
        entityType: 'Order',
        entityId: targetInternalId,
        details: {
          approvalRequestId,
          amount: totalAmount,
          riskScore: risk.score,
          riskClassification: risk.classification,
          reasons: risk.reasons,
        },
      });

      return {
        status: 'approval_required',
        approvalRequestId,
        reason,
      };
    }
  }

  const formattedAmount = totalAmount.toFixed(2);
  const description = `${product.name} (Qty: ${quantityToCharge})`;

  // Pass targetInternalId as requestId for idempotency across retries
  const paypalOrder = await paypalClient.createOrder({
    amount: formattedAmount,
    currency: currencyToCharge,
    description,
    requestId: targetInternalId,
  });

  if (isApprovedOrder) {
    // Reuse stored order: update with paypalOrderId and status CREATED in place.
    // Never create a second Order in the database for the same approval.
    await ordersRepository.updateOrderByInternalId(
      targetInternalId,
      'CREATED',
      paypalOrder.orderId
    );
  } else {
    // Persist order record in database with status CREATED after PayPal returns
    await ordersRepository.saveOrder({
      internalId: targetInternalId,
      paypalOrderId: paypalOrder.orderId,
      status: 'CREATED',
      productId: product.id,
      quantity: quantityToCharge,
      amount: totalAmount,
      currency: currencyToCharge,
    });
  }

  // Ensure risk assessment is saved for orders created directly or after approval
  const existingAssessment = await riskAssessmentRepository.findByOrderInternalId(
    targetInternalId
  );
  if (!existingAssessment) {
    const history = await ordersRepository.listOrders({}, 100);
    const risk = evaluateRisk(
      {
        internalId: targetInternalId,
        amount: totalAmount,
        currency: currencyToCharge,
        createdAt: new Date(),
      },
      history.map((h) => ({
        internalId: h.internalId,
        amount: h.amount,
        currency: h.currency,
        status: h.status,
        createdAt: h.createdAt,
      }))
    );
    await riskAssessmentRepository.saveAssessment({
      orderInternalId: targetInternalId,
      score: risk.score,
      classification: risk.classification,
      reasons: risk.reasons,
      recommendedAction: risk.recommendedAction,
    });
  }

  if (isApprovedOrder) {
    await auditLogRepository.recordLog({
      action: 'ORDER_CREATED_AFTER_APPROVAL',
      actor: 'BUYER',
      entityType: 'Order',
      entityId: targetInternalId,
      details: {
        paypalOrderId: paypalOrder.orderId,
        amount: totalAmount,
      },
    });
  }

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
 *    and updates status to COMPLETED instead of a false 503 error.
 * 4. Persists the order update to COMPLETED with captureId only after PayPal confirms COMPLETED.
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
          const captureId = captureObj?.id || '';
          const amount = captureObj?.amount?.value || '';
          const currency = captureObj?.amount?.currency_code || 'USD';

          // Persist verified status update to COMPLETED
          await ordersRepository.updateOrderStatus(orderId, 'COMPLETED', captureId);

          return {
            orderId,
            status: 'COMPLETED',
            captureId,
            amount,
            currency,
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

  // Persist verified status update to COMPLETED with captureId only after PayPal returns COMPLETED
  await ordersRepository.updateOrderStatus(orderId, 'COMPLETED', captureId);

  return {
    orderId,
    status: 'COMPLETED',
    captureId,
    amount,
    currency,
  };
}
