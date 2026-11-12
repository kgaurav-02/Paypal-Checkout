import { randomUUID } from 'crypto';
import { z } from 'zod';
import { env } from '../config/env';
import { approvalRequestsRepository } from '../repositories/approvalRequestsRepository';
import { auditLogRepository } from '../repositories/auditLogRepository';
import { clientsRepository } from '../repositories/clientsRepository';
import { financialPolicyRepository } from '../repositories/financialPolicyRepository';
import { invoicesRepository } from '../repositories/invoicesRepository';
import { ordersRepository } from '../repositories/ordersRepository';
import { riskAssessmentRepository } from '../repositories/riskAssessmentRepository';

export interface AssistantTool<TInput = any, TOutput = any> {
  name: string;
  description: string;
  schema: z.ZodType<TInput>;
  handler: (input: TInput) => Promise<TOutput>;
}

/**
 * 1. Read Tools (Safe Queries)
 */

export const getTransactionSummaryTool: AssistantTool = {
  name: 'getTransactionSummary',
  description: 'Get monthly transaction count and volume summary aggregated from stored orders.',
  schema: z.object({}).strict(),
  handler: async () => {
    return await ordersRepository.getMonthlySummary();
  },
};

export const listTransactionsTool: AssistantTool = {
  name: 'listTransactions',
  description: 'List recent stored order transactions, optionally filtered by status.',
  schema: z
    .object({
      status: z.string().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    })
    .strict(),
  handler: async (input) => {
    const limit = input.limit ?? 20;
    return await ordersRepository.listOrders(input.status ? { status: input.status } : undefined, limit);
  },
};

export const listPendingApprovalsTool: AssistantTool = {
  name: 'listPendingApprovals',
  description: 'List pending Guardian approval requests awaiting administrative decision.',
  schema: z.object({}).strict(),
  handler: async () => {
    return await approvalRequestsRepository.listApprovalRequests({ status: 'PENDING' });
  },
};

export const listClientsTool: AssistantTool = {
  name: 'listClients',
  description: 'List stored FreelancerPay clients.',
  schema: z.object({}).strict(),
  handler: async () => {
    return await clientsRepository.listClients();
  },
};

export const listInvoicesTool: AssistantTool = {
  name: 'listInvoices',
  description: 'List stored FreelancerPay invoices, optionally filtered by status.',
  schema: z
    .object({
      status: z.enum(['DRAFT', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED']).optional(),
    })
    .strict(),
  handler: async (input) => {
    return await invoicesRepository.listInvoices(input.status ? { status: input.status } : undefined);
  },
};

export const getRiskSummaryTool: AssistantTool = {
  name: 'getRiskSummary',
  description: 'Get aggregate FraudShield risk assessment summary and top triggered rules.',
  schema: z.object({}).strict(),
  handler: async () => {
    return await riskAssessmentRepository.getRiskSummary();
  },
};

export const getRiskAssessmentTool: AssistantTool = {
  name: 'getRiskAssessment',
  description: 'Get risk assessment and scoring breakdown for a specific order by its internal ID.',
  schema: z
    .object({
      orderInternalId: z.string().min(1, 'orderInternalId is required'),
    })
    .strict(),
  handler: async (input) => {
    const assessment = await riskAssessmentRepository.findByOrderInternalId(input.orderInternalId);
    if (!assessment) {
      throw new Error(`Risk assessment not found for order: ${input.orderInternalId}`);
    }
    return assessment;
  },
};

/**
 * 2. Write Tools (Strictly Gated by Guardian & Existing Services)
 */

export const createInvoiceDraftTool: AssistantTool = {
  name: 'createInvoiceDraft',
  description:
    'Create a draft invoice for a client with server-computed total. If total exceeds the financial policy limit, an ApprovalRequest is created in Guardian and the invoice is held for administrative approval.',
  schema: z
    .object({
      clientId: z.string().min(1, 'clientId is required'),
      items: z
        .array(
          z.object({
            description: z.string().min(1, 'Item description is required'),
            quantity: z.number().int().positive('Item quantity must be a positive integer'),
            unitPrice: z.number().positive('Item unit price must be positive'),
          })
        )
        .min(1, 'At least one item is required'),
      dueDate: z.string().datetime().optional(),
    })
    .strict(),
  handler: async (input) => {
    const client = await clientsRepository.findClientById(input.clientId);
    if (!client) {
      throw new Error(`Client not found with ID ${input.clientId}`);
    }

    const internalId = randomUUID();
    const invoice = await invoicesRepository.createInvoice(
      {
        clientId: input.clientId,
        items: input.items,
        dueDate: input.dueDate ? new Date(input.dueDate) : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        currency: 'USD',
      },
      internalId
    );

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
        actor: 'AI_ASSISTANT',
        entityType: 'Invoice',
        entityId: invoice.internalId,
        details: {
          approvalRequestId,
          total: invoice.total,
          threshold,
          reason,
        },
      });

      return {
        status: 'approval_required',
        approvalRequestId,
        reason,
        invoice,
      };
    }

    await auditLogRepository.recordLog({
      action: 'INVOICE_DRAFT_CREATED',
      actor: 'AI_ASSISTANT',
      entityType: 'Invoice',
      entityId: invoice.internalId,
      details: {
        total: invoice.total,
        itemCount: invoice.items.length,
      },
    });

    return {
      status: 'created',
      invoice,
    };
  },
};

export const requestOrderApprovalTool: AssistantTool = {
  name: 'requestOrderApproval',
  description:
    'Creates a PENDING ApprovalRequest in Guardian for an order. Never approves or rejects an order.',
  schema: z
    .object({
      orderInternalId: z.string().min(1, 'orderInternalId is required'),
      reason: z.string().min(1, 'Reason is required').optional(),
    })
    .strict(),
  handler: async (input) => {
    const order = await ordersRepository.findOrderByInternalId(input.orderInternalId);
    if (!order) {
      throw new Error(`Order not found with internalId: ${input.orderInternalId}`);
    }

    const approvalRequestId = randomUUID();
    const reason =
      input.reason ||
      `Administrative review requested via AI Assistant for order ${order.internalId} (${order.status})`;

    const approval = await approvalRequestsRepository.createApprovalRequest({
      internalId: approvalRequestId,
      orderInternalId: order.internalId,
      amount: order.amount,
      currency: order.currency,
      reason,
    });

    await auditLogRepository.recordLog({
      action: 'ORDER_APPROVAL_REQUESTED',
      actor: 'AI_ASSISTANT',
      entityType: 'Order',
      entityId: order.internalId,
      details: {
        approvalRequestId,
        amount: order.amount,
        reason,
      },
    });

    return {
      status: 'pending_approval',
      approvalRequest: approval,
    };
  },
};

/**
 * Complete Tool Registry
 */
export const toolRegistry: Record<string, AssistantTool> = {
  getTransactionSummary: getTransactionSummaryTool,
  listTransactions: listTransactionsTool,
  listPendingApprovals: listPendingApprovalsTool,
  listClients: listClientsTool,
  listInvoices: listInvoicesTool,
  getRiskSummary: getRiskSummaryTool,
  getRiskAssessment: getRiskAssessmentTool,
  createInvoiceDraft: createInvoiceDraftTool,
  requestOrderApproval: requestOrderApprovalTool,
};

export const ALLOWED_TOOL_NAMES = Object.keys(toolRegistry);

/**
 * Returns a registered tool by name
 */
export function getTool(name: string): AssistantTool | undefined {
  return toolRegistry[name];
}

/**
 * Safely executes a registered tool with input validation
 */
export async function executeTool(name: string, rawInput: unknown): Promise<any> {
  const tool = getTool(name);
  if (!tool) {
    throw new Error(`Tool "${name}" is not registered or allowed.`);
  }

  const parseResult = tool.schema.safeParse(rawInput ?? {});
  if (!parseResult.success) {
    throw new Error(`Invalid input for tool "${name}": ${parseResult.error.message}`);
  }

  return await tool.handler(parseResult.data);
}
