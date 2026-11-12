import http from 'http';
import { AddressInfo } from 'net';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import app from '../src/app';
import { connectDB, disconnectDB } from '../src/db/connect';
import { ApprovalRequestModel } from '../src/models/ApprovalRequest';
import { AuditLogModel } from '../src/models/AuditLog';
import { ClientModel } from '../src/models/Client';
import { InvoiceModel } from '../src/models/Invoice';
import { ProjectModel } from '../src/models/Project';
import { financialPolicyRepository } from '../src/repositories/financialPolicyRepository';
import * as paypalClient from '../src/services/paypalClient';

describe('FreelancerPay API & Business Rules', () => {
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
    if (mongoServer) {
      await mongoServer.stop();
    }
  }, 60000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await ClientModel.deleteMany({});
    await ProjectModel.deleteMany({});
    await InvoiceModel.deleteMany({});
    await ApprovalRequestModel.deleteMany({});
    await AuditLogModel.deleteMany({});
  });

  describe('Client Management (/api/clients)', () => {
    it('creates client with valid email and rejects invalid emails', async () => {
      // Valid client creation
      const res1 = await fetch(`${baseUrl}/api/clients`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Acme Corp',
          email: 'finance@acme.com',
          company: 'Acme Inc.',
        }),
      });
      expect(res1.status).toBe(201);
      const client = await res1.json();
      expect(client.name).toBe('Acme Corp');
      expect(client.email).toBe('finance@acme.com');

      // Invalid email rejection (400)
      const res2 = await fetch(`${baseUrl}/api/clients`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Invalid Client',
          email: 'not-an-email',
        }),
      });
      expect(res2.status).toBe(400);

      // Duplicate email rejection (409)
      const res3 = await fetch(`${baseUrl}/api/clients`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Acme Duplicate',
          email: 'finance@acme.com',
        }),
      });
      expect(res3.status).toBe(409);
    });
  });

  describe('Invoice Management & Policy Gating (/api/invoices)', () => {
    it('computes invoice total on the server from items and ignores client input', async () => {
      // 1. Create a client
      const clientRes = await fetch(`${baseUrl}/api/clients`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Dev Client',
          email: 'dev@client.com',
        }),
      });
      const client = await clientRes.json();

      // 2. Create an invoice with items: 2 * 25.00 = 50.00
      // Client attempts to pass a spoofed "total: 1.00"
      const res = await fetch(`${baseUrl}/api/invoices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: client._id,
          items: [
            { description: 'Frontend Development', quantity: 2, unitPrice: 25.0 },
          ],
          total: 1.0, // Should be ignored
          dueDate: new Date(Date.now() + 86400000).toISOString(),
        }),
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.invoice.total).toBe(50.0);
      expect(data.invoice.status).toBe('DRAFT');
    });

    it('rejects invalid amounts and quantities with 400', async () => {
      const client = await ClientModel.create({
        name: 'Test Client',
        email: 'test@client.com',
      });

      // Negative unitPrice
      const res1 = await fetch(`${baseUrl}/api/invoices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: client._id.toString(),
          items: [{ description: 'Invalid item', quantity: 1, unitPrice: -10 }],
          dueDate: new Date().toISOString(),
        }),
      });
      expect(res1.status).toBe(400);

      // Quantity < 1
      const res2 = await fetch(`${baseUrl}/api/invoices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: client._id.toString(),
          items: [{ description: 'Invalid qty', quantity: 0, unitPrice: 100 }],
          dueDate: new Date().toISOString(),
        }),
      });
      expect(res2.status).toBe(400);
    });

    it('invoice above threshold ($100) is NOT marked SENT until approved by administrator', async () => {
      const client = await ClientModel.create({
        name: 'High Value Client',
        email: 'vip@client.com',
      });

      // 1. Create invoice for $2,000 (exceeds $100 threshold)
      const createRes = await fetch(`${baseUrl}/api/invoices`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: client._id.toString(),
          items: [{ description: 'Full Platform Build', quantity: 1, unitPrice: 2000.0 }],
          dueDate: new Date(Date.now() + 86400000).toISOString(),
        }),
      });

      expect(createRes.status).toBe(202);
      const createData = await createRes.json();
      expect(createData.status).toBe('approval_required');
      expect(createData.approvalRequestId).toBeDefined();

      const invoiceId = createData.invoice.internalId;
      const approvalId = createData.approvalRequestId;

      // 2. Attempt to send invoice before approval -> Rejected with 403
      const sendBlockedRes = await fetch(`${baseUrl}/api/invoices/${invoiceId}/send`, {
        method: 'POST',
      });
      expect(sendBlockedRes.status).toBe(403);
      const sendBlockedData = await sendBlockedRes.json();
      expect(sendBlockedData.error.code).toBe('INVOICE_APPROVAL_REQUIRED');

      // 3. Administrator approves the request via /api/approvals/:id/approve
      const approveRes = await fetch(`${baseUrl}/api/approvals/${approvalId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decidedBy: 'admin@paypilot.internal' }),
      });
      expect(approveRes.status).toBe(200);

      // 4. Now send invoice -> Succeeds and marks status SENT after PayPal invoice created
      const paypalInvoiceSpy = vi
        .spyOn(paypalClient, 'createPayPalInvoice')
        .mockResolvedValue({
          invoiceId: 'INV2-TEST-PAYPAL-ID',
          href: 'https://api.sandbox.paypal.com/v2/invoicing/invoices/INV2-TEST-PAYPAL-ID',
        });

      const sendSuccessRes = await fetch(`${baseUrl}/api/invoices/${invoiceId}/send`, {
        method: 'POST',
      });
      expect(sendSuccessRes.status).toBe(200);
      const sendSuccessData = await sendSuccessRes.json();
      expect(sendSuccessData.status).toBe('SENT');
      expect(sendSuccessData.paypalInvoiceId).toBe('INV2-TEST-PAYPAL-ID');
      expect(sendSuccessData.invoice.status).toBe('SENT');
      expect(sendSuccessData.invoice.paypalInvoiceId).toBe('INV2-TEST-PAYPAL-ID');
      expect(paypalInvoiceSpy).toHaveBeenCalledTimes(1);
    });

    it('overdue marking marks SENT invoices past dueDate as OVERDUE', async () => {
      const client = await ClientModel.create({
        name: 'Late Client',
        email: 'late@client.com',
      });

      // Invoice 1: SENT and past dueDate (yesterday)
      const pastDate = new Date(Date.now() - 86400000);
      await InvoiceModel.create({
        internalId: 'INV_OVERDUE_TEST',
        clientId: client._id.toString(),
        items: [{ description: 'Consulting', quantity: 1, unitPrice: 50.0 }],
        total: 50.0,
        currency: 'USD',
        dueDate: pastDate,
        status: 'SENT',
      });

      // Invoice 2: DRAFT and past dueDate (should NOT be marked overdue, only SENT ones)
      await InvoiceModel.create({
        internalId: 'INV_DRAFT_TEST',
        clientId: client._id.toString(),
        items: [{ description: 'Draft service', quantity: 1, unitPrice: 50.0 }],
        total: 50.0,
        currency: 'USD',
        dueDate: pastDate,
        status: 'DRAFT',
      });

      // Invoice 3: SENT and future dueDate (tomorrow)
      const futureDate = new Date(Date.now() + 86400000);
      await InvoiceModel.create({
        internalId: 'INV_FUTURE_TEST',
        clientId: client._id.toString(),
        items: [{ description: 'Future service', quantity: 1, unitPrice: 50.0 }],
        total: 50.0,
        currency: 'USD',
        dueDate: futureDate,
        status: 'SENT',
      });

      // Call mark-overdue endpoint
      const overdueRes = await fetch(`${baseUrl}/api/invoices/mark-overdue`, {
        method: 'POST',
      });
      expect(overdueRes.status).toBe(200);
      const overdueData = await overdueRes.json();
      expect(overdueData.modifiedCount).toBe(1);

      // Verify statuses in database
      const inv1 = await InvoiceModel.findOne({ internalId: 'INV_OVERDUE_TEST' });
      expect(inv1?.status).toBe('OVERDUE');

      const inv2 = await InvoiceModel.findOne({ internalId: 'INV_DRAFT_TEST' });
      expect(inv2?.status).toBe('DRAFT');

      const inv3 = await InvoiceModel.findOne({ internalId: 'INV_FUTURE_TEST' });
      expect(inv3?.status).toBe('SENT');
    });
  });
});
