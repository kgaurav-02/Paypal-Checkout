import { describe, expect, it, vi } from 'vitest';
import {
  ALLOWED_TOOL_NAMES,
  executeTool,
  getTool,
  toolRegistry,
} from '../src/ai/tools';
import { ordersRepository } from '../src/repositories/ordersRepository';

describe('AI Assistant Tool Registry (Security & Strict Schema Gating)', () => {
  it('exposes only the strictly allowed tool names and no unauthorized actions', () => {
    const expectedTools = [
      'getTransactionSummary',
      'listTransactions',
      'listPendingApprovals',
      'listClients',
      'listInvoices',
      'getRiskSummary',
      'getRiskAssessment',
      'createInvoiceDraft',
      'requestOrderApproval',
    ];

    expect(ALLOWED_TOOL_NAMES.sort()).toEqual(expectedTools.sort());

    // Explicit security check: none of the tool names contain forbidden operations
    const forbiddenKeywords = ['approve', 'reject', 'capture', 'paypal', 'shell', 'exec', 'file', 'db', 'raw'];
    for (const name of ALLOWED_TOOL_NAMES) {
      for (const forbidden of forbiddenKeywords) {
        // 'requestOrderApproval' contains 'approval', but must NOT be 'approve'
        if (name === 'requestOrderApproval' && forbidden === 'approve') {
          expect(name).not.toBe('approve');
          continue;
        }
        expect(name.toLowerCase()).not.toContain(forbidden);
      }
    }
  });

  it('rejects execution of unregistered or forbidden tool names', async () => {
    await expect(executeTool('approve', {})).rejects.toThrow('is not registered or allowed');
    await expect(executeTool('reject', {})).rejects.toThrow('is not registered or allowed');
    await expect(executeTool('capture', {})).rejects.toThrow('is not registered or allowed');
    await expect(executeTool('capturePayment', {})).rejects.toThrow('is not registered or allowed');
    await expect(executeTool('paypalCapture', {})).rejects.toThrow('is not registered or allowed');
  });

  describe('Tool Input Schema Validations', () => {
    it('getTransactionSummary rejects invalid extra parameters', () => {
      const tool = getTool('getTransactionSummary')!;
      const result = tool.schema.safeParse({ invalidField: 'extra' });
      expect(result.success).toBe(false);
    });

    it('listTransactions rejects negative or invalid limit', () => {
      const tool = getTool('listTransactions')!;
      expect(tool.schema.safeParse({ limit: -5 }).success).toBe(false);
      expect(tool.schema.safeParse({ limit: 150 }).success).toBe(false);
      expect(tool.schema.safeParse({ limit: 'invalid' }).success).toBe(false);
      expect(tool.schema.safeParse({ limit: 10 }).success).toBe(true);
    });

    it('listInvoices rejects invalid statuses', () => {
      const tool = getTool('listInvoices')!;
      expect(tool.schema.safeParse({ status: 'INVALID_STATUS' }).success).toBe(false);
      expect(tool.schema.safeParse({ status: 'SENT' }).success).toBe(true);
      expect(tool.schema.safeParse({}).success).toBe(true);
    });

    it('getRiskAssessment rejects missing or empty orderInternalId', () => {
      const tool = getTool('getRiskAssessment')!;
      expect(tool.schema.safeParse({}).success).toBe(false);
      expect(tool.schema.safeParse({ orderInternalId: '' }).success).toBe(false);
      expect(tool.schema.safeParse({ orderInternalId: 'order-123' }).success).toBe(true);
    });

    it('createInvoiceDraft rejects invalid inputs, empty items, or non-positive prices', () => {
      const tool = getTool('createInvoiceDraft')!;
      // Missing clientId
      expect(tool.schema.safeParse({ items: [{ description: 'Test', quantity: 1, unitPrice: 10 }] }).success).toBe(false);
      // Empty items array
      expect(tool.schema.safeParse({ clientId: 'client-1', items: [] }).success).toBe(false);
      // Non-positive quantity
      expect(
        tool.schema.safeParse({
          clientId: 'client-1',
          items: [{ description: 'Test', quantity: 0, unitPrice: 10 }],
        }).success
      ).toBe(false);
      // Non-positive unitPrice
      expect(
        tool.schema.safeParse({
          clientId: 'client-1',
          items: [{ description: 'Test', quantity: 1, unitPrice: -5 }],
        }).success
      ).toBe(false);
      // Valid input
      expect(
        tool.schema.safeParse({
          clientId: 'client-1',
          items: [{ description: 'Consulting', quantity: 2, unitPrice: 100 }],
        }).success
      ).toBe(true);
    });

    it('requestOrderApproval rejects missing orderInternalId', () => {
      const tool = getTool('requestOrderApproval')!;
      expect(tool.schema.safeParse({}).success).toBe(false);
      expect(tool.schema.safeParse({ orderInternalId: '' }).success).toBe(false);
      expect(tool.schema.safeParse({ orderInternalId: 'ord-123' }).success).toBe(true);
    });
  });

  describe('Tool Execution Handlers', () => {
    it('executes getTransactionSummary calling ordersRepository', async () => {
      const summaryMock = {
        month: '2026-11',
        totalOrders: 10,
        completedOrders: 8,
        totalAmount: 400,
        completedAmount: 350,
        currency: 'USD',
        countsByStatus: { COMPLETED: 8, CREATED: 2 },
      };
      const spy = vi.spyOn(ordersRepository, 'getMonthlySummary').mockResolvedValue(summaryMock as any);

      const result = await executeTool('getTransactionSummary', {});
      expect(spy).toHaveBeenCalled();
      expect(result).toEqual(summaryMock);
    });
  });
});

