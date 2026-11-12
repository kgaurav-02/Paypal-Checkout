import http from 'http';
import { AddressInfo } from 'net';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import app from '../src/app';
import { connectDB, disconnectDB } from '../src/db/connect';
import { clientsRepository } from '../src/repositories/clientsRepository';
import { financialPolicyRepository } from '../src/repositories/financialPolicyRepository';
import { ordersRepository } from '../src/repositories/ordersRepository';
import { approvalRequestsRepository } from '../src/repositories/approvalRequestsRepository';

describe('Phase 8 Manual Demo Verification (AI Assistant End-to-End)', () => {
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
    await financialPolicyRepository.seedDefaultPolicy(100);

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

  it('executes the Phase 8 manual demo steps (a through d) and validates exact values', async () => {
    console.log('\n========================================');
    console.log('--- PHASE 8 MANUAL DEMO STEP a: Ask "summarize this month" ---');
    console.log('========================================');

    // 1. Fetch actual transactions summary
    const summaryRes = await fetch(`${baseUrl}/api/transactions/summary`);
    expect(summaryRes.status).toBe(200);
    const expectedSummary = await summaryRes.json();
    console.log('GET /api/transactions/summary result:', JSON.stringify(expectedSummary, null, 2));

    // 2. Ask assistant: "summarize this month"
    const assistantSummaryRes = await fetch(`${baseUrl}/api/assistant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'summarize this month' }),
    });
    expect(assistantSummaryRes.status).toBe(200);
    const assistantSummary = await assistantSummaryRes.json();
    console.log('POST /api/assistant ("summarize this month") response:', JSON.stringify(assistantSummary, null, 2));

    expect(assistantSummary.toolUsed).toBe('getTransactionSummary');
    expect(assistantSummary.result.totalOrders).toBe(expectedSummary.totalOrders);
    expect(assistantSummary.result.totalAmount).toBe(expectedSummary.totalAmount);
    expect(assistantSummary.result.completedOrders).toBe(expectedSummary.completedOrders);
    expect(assistantSummary.result.completedAmount).toBe(expectedSummary.completedAmount);
    console.log('>> CONFIRMED: Figures match GET /api/transactions/summary exactly.\n');

    console.log('========================================');
    console.log('--- PHASE 8 MANUAL DEMO STEP b: Ask "create an invoice for Acme Studio worth 2000" ---');
    console.log('========================================');

    // Seed client "Acme Studio"
    const client = await clientsRepository.createClient({
      name: 'Acme Studio',
      email: 'finance@acmestudio.com',
      company: 'Acme Studio Design Inc.',
    });
    console.log('Seeded client:', client.name, `(${client._id})`);

    const invoiceRes = await fetch(`${baseUrl}/api/assistant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'create an invoice for Acme Studio worth 2000' }),
    });
    expect(invoiceRes.status).toBe(200);
    const invoiceResult = await invoiceRes.json();
    console.log('POST /api/assistant ("create an invoice for Acme Studio worth 2000") response:', JSON.stringify(invoiceResult, null, 2));

    expect(invoiceResult.toolUsed).toBe('createInvoiceDraft');
    expect(invoiceResult.result.status).toBe('approval_required');
    expect(invoiceResult.result.invoice.total).toBe(2000);
    expect(invoiceResult.result.invoice.status).toBe('DRAFT');
    expect(invoiceResult.result.approvalRequestId).toBeDefined();

    // Verify approval request is stored in Guardian as PENDING
    const pendingRequests = await approvalRequestsRepository.listApprovalRequests({ status: 'PENDING' });
    const match = pendingRequests.find((r) => r.internalId === invoiceResult.result.approvalRequestId);
    expect(match).toBeDefined();
    expect(match?.amount).toBe(2000);
    console.log('>> CONFIRMED: Invoice was created as DRAFT and waits for Guardian administrative approval.\n');

    console.log('========================================');
    console.log('--- PHASE 8 MANUAL DEMO STEP c: Ask "approve order <id>" ---');
    console.log('========================================');

    const approveOrderRes = await fetch(`${baseUrl}/api/assistant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'approve order 4ea62cb2-6794-4a99-a48e-8f0f3189fe49' }),
    });
    expect(approveOrderRes.status).toBe(200);
    const approveResult = await approveOrderRes.json();
    console.log('POST /api/assistant ("approve order ...") response:', JSON.stringify(approveResult, null, 2));

    expect(approveResult.refused).toBe(true);
    expect(approveResult.reply).toContain('Guardian panel');
    expect(approveResult.toolUsed).toBeUndefined();
    console.log('>> CONFIRMED: Approval action was strictly refused by AI Assistant security policy.\n');

    console.log('========================================');
    console.log('--- PHASE 8 MANUAL DEMO STEP d: Ask "risk summary" ---');
    console.log('========================================');

    const riskSummaryRes = await fetch(`${baseUrl}/api/risk/summary`);
    expect(riskSummaryRes.status).toBe(200);
    const expectedRiskSummary = await riskSummaryRes.json();
    console.log('GET /api/risk/summary result:', JSON.stringify(expectedRiskSummary, null, 2));

    const assistantRiskRes = await fetch(`${baseUrl}/api/assistant`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'risk summary' }),
    });
    expect(assistantRiskRes.status).toBe(200);
    const assistantRiskResult = await assistantRiskRes.json();
    console.log('POST /api/assistant ("risk summary") response:', JSON.stringify(assistantRiskResult, null, 2));

    expect(assistantRiskResult.toolUsed).toBe('getRiskSummary');
    expect(assistantRiskResult.result.totalAssessed).toBe(expectedRiskSummary.totalAssessed);
    expect(assistantRiskResult.result.countsByClassification).toEqual(expectedRiskSummary.countsByClassification);
    console.log('>> CONFIRMED: Risk summary matches GET /api/risk/summary exactly.\n');
  });
});

