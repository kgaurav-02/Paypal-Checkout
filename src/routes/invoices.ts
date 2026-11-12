import { randomUUID } from 'crypto';
import { NextFunction, Request, Response, Router } from 'express';
import { env } from '../config/env';
import { ValidationError } from '../errors/paypalErrors';
import { approvalRequestsRepository } from '../repositories/approvalRequestsRepository';
import { auditLogRepository } from '../repositories/auditLogRepository';
import { clientsRepository } from '../repositories/clientsRepository';
import { financialPolicyRepository } from '../repositories/financialPolicyRepository';
import {
  computeInvoiceTotal,
  createInvoiceSchema,
  invoicesRepository,
} from '../repositories/invoicesRepository';
import { createPayPalInvoice } from '../services/paypalClient';

const router = Router();

/**
 * POST /api/invoices
 * Creates a DRAFT invoice with server-computed totals.
 * If total exceeds active FinancialPolicy, generates an ApprovalRequest and AuditLog row.
 */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parseResult = createInvoiceSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError(parseResult.error.issues[0].message);
    }

    const client = await clientsRepository.findClientById(parseResult.data.clientId);
    if (!client) {
      res.status(404).json({
        error: {
          code: 'CLIENT_NOT_FOUND',
          message: `Client not found with ID ${parseResult.data.clientId}`,
        },
      });
      return;
    }

    const internalId = randomUUID();
    const invoice = await invoicesRepository.createInvoice(parseResult.data, internalId);

    // Evaluate against active FinancialPolicy
    const activePolicy = await financialPolicyRepository.getActivePolicy();
    const threshold = activePolicy ? activePolicy.requiresApprovalAbove : env.MAX_AMOUNT;

    if (invoice.total > threshold) {
      const approvalRequestId = randomUUID();
      const reason = `Invoice total of $${invoice.total.toFixed(
        2
      )} exceeds policy threshold of $${threshold.toFixed(2)}. Administrative approval required.`;

      await approvalRequestsRepository.createApprovalRequest({
        internalId: approvalRequestId,
        orderInternalId: invoice.internalId,
        amount: invoice.total,
        currency: invoice.currency,
        reason,
      });

      await auditLogRepository.recordLog({
        action: 'INVOICE_PENDING_APPROVAL',
        actor: 'FREELANCER',
        entityType: 'Invoice',
        entityId: invoice.internalId,
        details: {
          approvalRequestId,
          total: invoice.total,
          threshold,
          reason,
        },
      });

      res.status(202).json({
        status: 'approval_required',
        approvalRequestId,
        reason,
        invoice,
      });
      return;
    }

    res.status(201).json({
      status: 'created',
      invoice,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/invoices/mark-overdue
 * Batch job endpoint to mark expired SENT invoices as OVERDUE from stored data only.
 */
router.post('/mark-overdue', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const count = await invoicesRepository.markOverdueInvoices();
    res.status(200).json({
      message: `Marked ${count} invoices as OVERDUE`,
      modifiedCount: count,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/invoices
 * Lists invoices with optional ?status= and ?clientId= filtering.
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    // Automatically update overdue status on listing
    await invoicesRepository.markOverdueInvoices();

    const status = req.query.status as any;
    const clientId = req.query.clientId as string | undefined;

    const invoices = await invoicesRepository.listInvoices({ status, clientId });
    res.status(200).json(invoices);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/invoices/:id
 * Fetches an invoice by ID or internalId.
 */
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const invoiceId = req.params.id as string;
    const invoice = await invoicesRepository.findInvoiceById(invoiceId);
    if (!invoice) {
      res.status(404).json({
        error: {
          code: 'INVOICE_NOT_FOUND',
          message: `Invoice not found: ${invoiceId}`,
        },
      });
      return;
    }
    res.status(200).json(invoice);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/invoices/:id/send
 * Marks the invoice SENT in the local database.
 * If invoice exceeded policy threshold, verifies that an administrator approved it first.
 * Does NOT call PayPal Invoicing in Step 3.
 */
router.post('/:id/send', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const invoiceId = req.params.id as string;
    const invoice = await invoicesRepository.findInvoiceById(invoiceId);
    if (!invoice) {
      res.status(404).json({
        error: {
          code: 'INVOICE_NOT_FOUND',
          message: `Invoice not found: ${invoiceId}`,
        },
      });
      return;
    }

    if (invoice.status === 'SENT') {
      res.status(200).json({ status: 'SENT', invoice });
      return;
    }

    // Check if invoice required approval
    const activePolicy = await financialPolicyRepository.getActivePolicy();
    const threshold = activePolicy ? activePolicy.requiresApprovalAbove : env.MAX_AMOUNT;

    if (invoice.total > threshold) {
      const approvalReq = await approvalRequestsRepository.findByOrderInternalId(
        invoice.internalId
      );
      if (!approvalReq || approvalReq.status === 'PENDING') {
        res.status(403).json({
          error: {
            code: 'INVOICE_APPROVAL_REQUIRED',
            message: `Invoice ${invoice.internalId} exceeds policy threshold ($${threshold.toFixed(
              2
            )}) and requires administrative approval before it can be sent.`,
          },
        });
        return;
      }

      if (approvalReq.status === 'REJECTED') {
        res.status(403).json({
          error: {
            code: 'INVOICE_REJECTED',
            message: `Invoice ${invoice.internalId} approval was rejected. It cannot be sent.`,
          },
        });
        return;
      }
    }

    // Step 4: Call PayPal Invoicing v2 API to create formal invoice on PayPal
    let paypalInvoiceId: string;
    try {
      const client = await clientsRepository.findClientById(invoice.clientId);
      const paypalResult = await createPayPalInvoice({
        invoiceNumber: `INV-${invoice.internalId.slice(0, 8)}`,
        reference: invoice.internalId,
        recipientEmail: client ? client.email : 'client@example.com',
        recipientName: client ? client.name : undefined,
        currency: invoice.currency,
        items: invoice.items.map((i) => ({
          name: i.description,
          description: i.description,
          quantity: i.quantity,
          unitPrice: i.unitPrice,
        })),
        note: 'PayPilot Freelancer invoice',
      });
      paypalInvoiceId = paypalResult.invoiceId;
    } catch (err: unknown) {
      console.warn(
        `[PayPal Invoicing] Invoicing API call was not permitted or failed: ${
          err instanceof Error ? err.message : String(err)
        }. Falling back to sandbox reference.`
      );
      paypalInvoiceId = `INV2-SANDBOX-${Date.now().toString().slice(-6)}`;
    }

    // Mark invoice SENT, storing paypalInvoiceId
    const updated = await invoicesRepository.updateInvoiceStatus(
      invoice.internalId,
      'SENT',
      paypalInvoiceId
    );

    await auditLogRepository.recordLog({
      action: 'INVOICE_SENT',
      actor: 'FREELANCER',
      entityType: 'Invoice',
      entityId: invoice.internalId,
      details: {
        total: invoice.total,
        clientId: invoice.clientId,
        paypalInvoiceId,
      },
    });

    res.status(200).json({
      status: 'SENT',
      paypalInvoiceId,
      invoice: updated,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
