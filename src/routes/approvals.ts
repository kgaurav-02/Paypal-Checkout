import { NextFunction, Request, Response, Router } from 'express';
import { z } from 'zod';
import { ApprovalConflictError } from '../errors/paypalErrors';
import { approvalRequestsRepository } from '../repositories/approvalRequestsRepository';
import { auditLogRepository } from '../repositories/auditLogRepository';
import { ordersRepository } from '../repositories/ordersRepository';

const router = Router();

const approvalParamSchema = z.object({
  id: z.string().min(1, 'Approval request ID is required'),
});

const decisionBodySchema = z.object({
  decidedBy: z.string().optional(),
});

/**
 * GET /api/approvals
 * Lists approval requests with optional status filtering (?status=PENDING).
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = req.query.status as any;
    const requests = await approvalRequestsRepository.listApprovalRequests({ status });
    res.status(200).json(requests);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/approvals/:id/approve
 * Human decision to approve an order above policy threshold.
 * Updates ApprovalRequest to APPROVED, moves Order to APPROVED, and writes an AuditLog entry.
 * It must NOT call PayPal here.
 * Rejects double decisions with 409 Conflict.
 */
router.post('/:id/approve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const params = approvalParamSchema.parse(req.params);
    const body = decisionBodySchema.parse(req.body || {});
    const decidedBy = body.decidedBy || 'ADMIN';

    const decisionResult = await approvalRequestsRepository.recordDecision(
      params.id,
      'APPROVED',
      decidedBy
    );

    if (decisionResult.status === 'NOT_FOUND') {
      res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: `Approval request not found: ${params.id}`,
        },
      });
      return;
    }

    if (decisionResult.status === 'ALREADY_DECIDED') {
      throw new ApprovalConflictError(
        `Approval request ${params.id} has already been decided (${decisionResult.request.status}).`
      );
    }

    // Move matching Order to APPROVED (no PayPal call)
    await ordersRepository.updateOrderByInternalId(
      decisionResult.request.orderInternalId,
      'APPROVED'
    );

    // Record audit log entry
    await auditLogRepository.recordLog({
      action: 'APPROVAL_REQUEST_APPROVED',
      actor: decidedBy,
      entityType: 'ApprovalRequest',
      entityId: params.id,
      details: {
        orderInternalId: decisionResult.request.orderInternalId,
        amount: decisionResult.request.amount,
        currency: decisionResult.request.currency,
      },
    });

    res.status(200).json({
      status: 'APPROVED',
      approvalRequestId: params.id,
      orderInternalId: decisionResult.request.orderInternalId,
      decidedBy,
      decidedAt: decisionResult.request.decidedAt,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/approvals/:id/reject
 * Human decision to reject an order above policy threshold.
 * Updates ApprovalRequest to REJECTED, moves Order to REJECTED, and writes an AuditLog entry.
 * Rejects double decisions with 409 Conflict.
 */
router.post('/:id/reject', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const params = approvalParamSchema.parse(req.params);
    const body = decisionBodySchema.parse(req.body || {});
    const decidedBy = body.decidedBy || 'ADMIN';

    const decisionResult = await approvalRequestsRepository.recordDecision(
      params.id,
      'REJECTED',
      decidedBy
    );

    if (decisionResult.status === 'NOT_FOUND') {
      res.status(404).json({
        error: {
          code: 'NOT_FOUND',
          message: `Approval request not found: ${params.id}`,
        },
      });
      return;
    }

    if (decisionResult.status === 'ALREADY_DECIDED') {
      throw new ApprovalConflictError(
        `Approval request ${params.id} has already been decided (${decisionResult.request.status}).`
      );
    }

    // Move matching Order to REJECTED
    await ordersRepository.updateOrderByInternalId(
      decisionResult.request.orderInternalId,
      'REJECTED'
    );

    // Record audit log entry
    await auditLogRepository.recordLog({
      action: 'APPROVAL_REQUEST_REJECTED',
      actor: decidedBy,
      entityType: 'ApprovalRequest',
      entityId: params.id,
      details: {
        orderInternalId: decisionResult.request.orderInternalId,
        amount: decisionResult.request.amount,
        currency: decisionResult.request.currency,
      },
    });

    res.status(200).json({
      status: 'REJECTED',
      approvalRequestId: params.id,
      orderInternalId: decisionResult.request.orderInternalId,
      decidedBy,
      decidedAt: decisionResult.request.decidedAt,
    });
  } catch (err) {
    next(err);
  }
});

export default router;

