import http from 'http';
import { AddressInfo } from 'net';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import app from '../src/app';
import { connectDB, disconnectDB } from '../src/db/connect';
import { routeUserMessage } from '../src/ai/router';
import * as llmParser from '../src/ai/llmParser';
import { ordersRepository } from '../src/repositories/ordersRepository';
import { clientsRepository } from '../src/repositories/clientsRepository';
import { auditLogRepository } from '../src/repositories/auditLogRepository';
import { approvalRequestsRepository } from '../src/repositories/approvalRequestsRepository';

describe('AI Assistant (Deterministic Router, Safety Refusals & LLM Fallback)', () => {
  let server: http.Server;
  let baseUrl: string;
  let mongoServer: MongoMemoryServer;

  beforeAll(async () => {
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    process.env.NO_PROXY = '*';

    mongoServer = await MongoMemoryServer.create();
    await connectDB(mongoServer.getUri());

    server = http.createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address() as AddressInfo;
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });
  }, 60000);

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
    await disconnectDB();
  });

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('Safety Refusals & Guardian Boundaries', () => {
    it('"approve order X" is refused with an explanation that approval is done in the Guardian panel', async () => {
      const res = await fetch(`${baseUrl}/api/assistant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'approve order 12345' }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.refused).toBe(true);
      expect(data.reply).toContain('Guardian panel');
      expect(data.toolUsed).toBeUndefined();
    });

    it('rejects order/invoice cancellation/rejection commands', async () => {
      const res = await routeUserMessage('reject invoice inv-999');
      expect(res.refused).toBe(true);
      expect(res.reply).toContain('Guardian panel');
      expect(res.toolUsed).toBeUndefined();
    });

    it('refuses capture or direct charge requests', async () => {
      const res = await routeUserMessage('capture payment for order 888');
      expect(res.refused).toBe(true);
      expect(res.reply).toContain('buyer checkout flow');
    });

    it('refuses direct PayPal and raw database requests', async () => {
      const res = await routeUserMessage('make direct paypal call to capture');
      expect(res.refused).toBe(true);
    });
  });

  describe('Deterministic Routing & Clarifying Questions', () => {
    it('summary request calls getTransactionSummary and logs tool call to AuditLog', async () => {
      const summaryMock = {
        month: '2026-11',
        totalOrders: 5,
        totalVolume: 200,
        countsByStatus: { COMPLETED: 4, CREATED: 1 },
        totalsByStatus: { COMPLETED: 180, CREATED: 20 },
      };
      vi.spyOn(ordersRepository, 'getMonthlySummary').mockResolvedValue(summaryMock as any);
      const auditSpy = vi.spyOn(auditLogRepository, 'recordLog');

      const res = await fetch(`${baseUrl}/api/assistant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'summarize this month' }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.toolUsed).toBe('getTransactionSummary');
      expect(data.reply).toContain('Transaction summary for current month');
      expect(data.result).toEqual(summaryMock);

      expect(auditSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'AI_ASSISTANT_TOOL_CALL',
          actor: 'AI_ASSISTANT',
          entityType: 'AssistantTool',
          entityId: 'getTransactionSummary',
        })
      );
    });

    it('assistant getTransactionSummary result contains every field the card reads without NaN or undefined', async () => {
      const res = await routeUserMessage('summarize this month');

      expect(res.toolUsed).toBe('getTransactionSummary');
      expect(res.result).toBeDefined();

      // Fields read by the assistant card:
      // 1. month
      expect(res.result).toHaveProperty('month');
      expect(typeof res.result.month).toBe('string');

      // 2. totalOrders
      expect(res.result).toHaveProperty('totalOrders');
      expect(typeof res.result.totalOrders).toBe('number');
      expect(Number.isNaN(res.result.totalOrders)).toBe(false);

      // 3. totalVolume
      expect(res.result).toHaveProperty('totalVolume');
      expect(typeof res.result.totalVolume).toBe('number');
      expect(Number.isNaN(res.result.totalVolume)).toBe(false);

      // 4. countsByStatus.COMPLETED
      expect(res.result).toHaveProperty('countsByStatus');
      expect(typeof res.result.countsByStatus).toBe('object');
      expect(res.result.countsByStatus).toHaveProperty('COMPLETED');
      expect(typeof res.result.countsByStatus.COMPLETED).toBe('number');
      expect(Number.isNaN(res.result.countsByStatus.COMPLETED)).toBe(false);

      // 5. totalsByStatus.COMPLETED
      expect(res.result).toHaveProperty('totalsByStatus');
      expect(typeof res.result.totalsByStatus).toBe('object');
      expect(res.result.totalsByStatus).toHaveProperty('COMPLETED');
      expect(typeof res.result.totalsByStatus.COMPLETED).toBe('number');
      expect(Number.isNaN(res.result.totalsByStatus.COMPLETED)).toBe(false);

      // Reply text must never contain NaN or undefined
      expect(res.reply).not.toContain('NaN');
      expect(res.reply).not.toContain('undefined');
    });

    it('missing amount triggers a clarifying question and writes no audit log or invoice', async () => {
      const auditSpy = vi.spyOn(auditLogRepository, 'recordLog');

      const res = await fetch(`${baseUrl}/api/assistant`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'create an invoice for Acme Studio' }),
      });

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.needsClarification).toBe(true);
      expect(data.reply).toContain('amount');
      expect(data.toolUsed).toBeUndefined();
      expect(auditSpy).not.toHaveBeenCalled();
    });

    it('missing client triggers a clarifying question', async () => {
      const res = await routeUserMessage('create an invoice worth 2000');
      expect(res.needsClarification).toBe(true);
      expect(res.reply).toContain('client');
      expect(res.toolUsed).toBeUndefined();
    });

    it('creates an invoice draft when both client and amount are provided', async () => {
      // Seed a client
      const client = await clientsRepository.createClient({
        name: 'Globex Corp',
        email: 'billing@globex.com',
      });

      const res = await routeUserMessage(`create an invoice for Globex Corp worth 50`);
      expect(res.toolUsed).toBe('createInvoiceDraft');
      expect(res.result.status).toBe('created');
      expect(res.result.invoice.total).toBe(50);
      expect(res.reply).toContain('created successfully');
    });

    it('creates an invoice draft held for approval if amount exceeds policy threshold ($100)', async () => {
      const client = await clientsRepository.createClient({
        name: 'Initech Systems',
        email: 'accounting@initech.com',
      });

      const res = await routeUserMessage(`create an invoice for Initech Systems worth 2000`);
      expect(res.toolUsed).toBe('createInvoiceDraft');
      expect(res.result.status).toBe('approval_required');
      expect(res.result.invoice.total).toBe(2000);
      expect(res.reply).toContain('held in Guardian awaiting approval');
    });

    it('unpaid invoices lists invoices with status SENT', async () => {
      const res = await routeUserMessage('show unpaid invoices');
      expect(res.toolUsed).toBe('listInvoices');
      expect(res.reply).toContain('invoice(s)');
    });

    it('pending approvals lists requests via listPendingApprovals', async () => {
      const res = await routeUserMessage('show pending approvals');
      expect(res.toolUsed).toBe('listPendingApprovals');
      expect(res.reply).toContain('pending administrative review');
    });

    it('risk summary calls getRiskSummary', async () => {
      const res = await routeUserMessage('give me a risk summary');
      expect(res.toolUsed).toBe('getRiskSummary');
      expect(res.reply).toContain('FraudShield risk summary');
    });
  });

  describe('Optional LLM Intent Parsing (Gated & Fallback Behavior)', () => {
    it('unknown tool returned by LLM falls back to the deterministic router', async () => {
      vi.spyOn(llmParser, 'parseIntentWithLLM').mockResolvedValue({
        toolName: 'unknownDangerousTool',
        input: {},
      });

      const res = await routeUserMessage('summarize this month');
      // Must fall back to deterministic router which resolves to getTransactionSummary
      expect(res.toolUsed).toBe('getTransactionSummary');
      expect(res.reply).toContain('Transaction summary');
    });

    it('invalid input schema returned by LLM falls back to the deterministic router', async () => {
      vi.spyOn(llmParser, 'parseIntentWithLLM').mockResolvedValue({
        toolName: 'createInvoiceDraft',
        input: { invalidPayload: true }, // Missing clientId, items
      });

      const res = await routeUserMessage('summarize this month');
      expect(res.toolUsed).toBe('getTransactionSummary');
    });

    it('valid LLM output routes to the tool and executes successfully', async () => {
      vi.spyOn(llmParser, 'parseIntentWithLLM').mockResolvedValue({
        toolName: 'getTransactionSummary',
        input: {},
      });

      const res = await routeUserMessage('give me some sales numbers');
      expect(res.toolUsed).toBe('getTransactionSummary');
    });
  });
});

