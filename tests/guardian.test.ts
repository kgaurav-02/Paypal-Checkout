import { randomUUID } from 'crypto';
import http from 'http';
import { AddressInfo } from 'net';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import app from '../src/app';
import { connectDB, disconnectDB } from '../src/db/connect';
import { ApprovalRequestModel } from '../src/models/ApprovalRequest';
import { AuditLogModel } from '../src/models/AuditLog';
import { FinancialPolicyModel } from '../src/models/FinancialPolicy';
import { OrderModel } from '../src/models/Order';
import * as paypalClient from '../src/services/paypalClient';

describe('Guardian Approval Workflow, Audit Log & Transactions API', () => {
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
    if (mongoServer) {
      await mongoServer.stop();
    }
  }, 60000);

  afterEach(async () => {
    vi.restoreAllMocks();
    await OrderModel.deleteMany({});
    await ApprovalRequestModel.deleteMany({});
    await AuditLogModel.deleteMany({});
  });

  describe('Guardian Policy Evaluation & Approval Workflow', () => {
    it('order amount above threshold writes no PayPal call and saves PENDING_APPROVAL', async () => {
      const createOrderSpy = vi.spyOn(paypalClient, 'createOrder');
      const checkoutAttemptId = randomUUID();

      // Qty 3 * $49.99 = $149.97 > $100
      const res = await fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: 'demo-headphones',
          quantity: 3,
          checkoutAttemptId,
        }),
      });

      expect(res.status).toBe(202);
      const data = await res.json();
      expect(data.status).toBe('approval_required');
      expect(data.approvalRequestId).toBeDefined();

      // PayPal must NOT be called
      expect(createOrderSpy).not.toHaveBeenCalled();

      // Order saved in DB with status PENDING_APPROVAL
      const order = await OrderModel.findOne({ internalId: checkoutAttemptId });
      expect(order).not.toBeNull();
      expect(order?.status).toBe('PENDING_APPROVAL');
      expect(order?.amount).toBe(149.97);

      // ApprovalRequest saved with PENDING status
      const req = await ApprovalRequestModel.findOne({ internalId: data.approvalRequestId });
      expect(req).not.toBeNull();
      expect(req?.status).toBe('PENDING');
      expect(req?.orderInternalId).toBe(checkoutAttemptId);

      // AuditLog entry written
      const audit = await AuditLogModel.findOne({ entityId: checkoutAttemptId });
      expect(audit).not.toBeNull();
      expect(audit?.action).toBe('ORDER_PENDING_APPROVAL');
    });

    it('approving an order moves it to APPROVED (no PayPal call), then buyer checkout succeeds', async () => {
      const createOrderSpy = vi.spyOn(paypalClient, 'createOrder').mockResolvedValue({
        orderId: 'PAYPAL_ORDER_AFTER_APPROVAL',
        status: 'CREATED',
      });

      const checkoutAttemptId = randomUUID();

      // Step 1: Buyer initiates order above threshold -> 202
      const initRes = await fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: 'demo-headphones',
          quantity: 3,
          checkoutAttemptId,
        }),
      });
      expect(initRes.status).toBe(202);
      const initData = await initRes.json();
      const approvalId = initData.approvalRequestId;
      expect(createOrderSpy).not.toHaveBeenCalled();

      // Step 2: Administrator approves the request
      const approveRes = await fetch(`${baseUrl}/api/approvals/${approvalId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decidedBy: 'admin@paypilot.internal' }),
      });
      expect(approveRes.status).toBe(200);
      const approveData = await approveRes.json();
      expect(approveData.status).toBe('APPROVED');
      expect(approveData.decidedBy).toBe('admin@paypilot.internal');

      // Crucial requirement: Approval MUST NOT call PayPal!
      expect(createOrderSpy).not.toHaveBeenCalled();

      // Order status is now APPROVED
      const approvedOrder = await OrderModel.findOne({ internalId: checkoutAttemptId });
      expect(approvedOrder?.status).toBe('APPROVED');

      // Approval audit log row written
      const approveAudit = await AuditLogModel.findOne({
        action: 'APPROVAL_REQUEST_APPROVED',
        entityId: approvalId,
      });
      expect(approveAudit).not.toBeNull();
      expect(approveAudit?.actor).toBe('admin@paypilot.internal');

      // Step 3: Buyer's checkout flow re-calls /api/orders with the same checkoutAttemptId
      const resumeRes = await fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: 'demo-headphones',
          quantity: 3,
          checkoutAttemptId,
        }),
      });

      expect(resumeRes.status).toBe(201);
      const resumeData = await resumeRes.json();
      expect(resumeData.orderId).toBe('PAYPAL_ORDER_AFTER_APPROVAL');

      // PayPal createOrder was called exactly once by the buyer's checkout flow
      expect(createOrderSpy).toHaveBeenCalledTimes(1);

      // Order is now persisted with status CREATED and paypalOrderId
      const finalOrder = await OrderModel.findOne({ internalId: checkoutAttemptId });
      expect(finalOrder?.status).toBe('CREATED');
      expect(finalOrder?.paypalOrderId).toBe('PAYPAL_ORDER_AFTER_APPROVAL');

      // Audit log row written for buyer order creation after approval
      const orderCreatedAudit = await AuditLogModel.findOne({
        action: 'ORDER_CREATED_AFTER_APPROVAL',
        entityId: checkoutAttemptId,
      });
      expect(orderCreatedAudit).not.toBeNull();
    });

    it('rejecting an order blocks subsequent PayPal creation', async () => {
      const createOrderSpy = vi.spyOn(paypalClient, 'createOrder');
      const checkoutAttemptId = randomUUID();

      // Buyer initiates order -> 202
      const initRes = await fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: 'demo-headphones',
          quantity: 3,
          checkoutAttemptId,
        }),
      });
      const initData = await initRes.json();
      const approvalId = initData.approvalRequestId;

      // Administrator rejects the request
      const rejectRes = await fetch(`${baseUrl}/api/approvals/${approvalId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decidedBy: 'compliance@paypilot.internal' }),
      });
      expect(rejectRes.status).toBe(200);
      const rejectData = await rejectRes.json();
      expect(rejectData.status).toBe('REJECTED');

      // Order is REJECTED
      const rejectedOrder = await OrderModel.findOne({ internalId: checkoutAttemptId });
      expect(rejectedOrder?.status).toBe('REJECTED');

      // Audit log written for rejection
      const rejectAudit = await AuditLogModel.findOne({
        action: 'APPROVAL_REQUEST_REJECTED',
        entityId: approvalId,
      });
      expect(rejectAudit).not.toBeNull();
      expect(rejectAudit?.actor).toBe('compliance@paypilot.internal');

      // Buyer tries to create order -> blocked (403)
      const tryRes = await fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: 'demo-headphones',
          quantity: 3,
          checkoutAttemptId,
        }),
      });
      expect(tryRes.status).toBe(403);
      const tryData = await tryRes.json();
      expect(tryData.error.code).toBe('ORDER_REJECTED');

      // PayPal must never be called
      expect(createOrderSpy).not.toHaveBeenCalled();
    });

    it('rejects double decision on the same approval request with 409', async () => {
      const checkoutAttemptId = randomUUID();

      const initRes = await fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: 'demo-headphones',
          quantity: 3,
          checkoutAttemptId,
        }),
      });
      const initData = await initRes.json();
      const approvalId = initData.approvalRequestId;

      // First decision: approve
      const res1 = await fetch(`${baseUrl}/api/approvals/${approvalId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      expect(res1.status).toBe(200);

      // Second decision on same request: approve again -> 409
      const res2 = await fetch(`${baseUrl}/api/approvals/${approvalId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      expect(res2.status).toBe(409);
      const data2 = await res2.json();
      expect(data2.error.code).toBe('APPROVAL_CONFLICT');

      // Third decision on same request: reject -> 409
      const res3 = await fetch(`${baseUrl}/api/approvals/${approvalId}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      expect(res3.status).toBe(409);
      const data3 = await res3.json();
      expect(data3.error.code).toBe('APPROVAL_CONFLICT');
    });

    it('GET /api/approvals?status=PENDING lists pending requests', async () => {
      const checkoutAttemptId = randomUUID();

      await fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: 'demo-headphones',
          quantity: 3,
          checkoutAttemptId,
        }),
      });

      const listRes = await fetch(`${baseUrl}/api/approvals?status=PENDING`);
      expect(listRes.status).toBe(200);
      const list = await listRes.json();
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBe(1);
      expect(list[0].orderInternalId).toBe(checkoutAttemptId);
      expect(list[0].status).toBe('PENDING');
    });

    it('unapproved order above the threshold still returns 202 and makes no PayPal call', async () => {
      const createOrderSpy = vi.spyOn(paypalClient, 'createOrder');
      const checkoutAttemptId = randomUUID();

      // Attempt 1: unapproved order above threshold ($149.97 > $100)
      const res1 = await fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: 'demo-headphones',
          quantity: 3,
          checkoutAttemptId,
        }),
      });

      expect(res1.status).toBe(202);
      const data1 = await res1.json();
      expect(data1.status).toBe('approval_required');
      expect(data1.approvalRequestId).toBeDefined();
      expect(createOrderSpy).not.toHaveBeenCalled();

      // Attempt 2: retry before approval referencing orderInternalId
      const res2 = await fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: 'demo-headphones',
          quantity: 3,
          checkoutAttemptId: randomUUID(),
          orderInternalId: checkoutAttemptId,
          approvalRequestId: data1.approvalRequestId,
        }),
      });

      expect(res2.status).toBe(202);
      const data2 = await res2.json();
      expect(data2.status).toBe('approval_required');
      // PayPal must still NOT have been called
      expect(createOrderSpy).not.toHaveBeenCalled();
    });

    it('an APPROVED order creates a PayPal order exactly once and second create does not create duplicate', async () => {
      const createOrderSpy = vi.spyOn(paypalClient, 'createOrder').mockResolvedValue({
        orderId: 'PAYPAL_ORDER_APPROVED_FLOW',
        status: 'CREATED',
      });

      const checkoutAttemptId = randomUUID();

      // Step 1: Buyer initiates order above threshold -> 202 approval_required
      const initRes = await fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: 'demo-headphones',
          quantity: 3,
          checkoutAttemptId,
        }),
      });
      expect(initRes.status).toBe(202);
      const initData = await initRes.json();
      const approvalId = initData.approvalRequestId;
      expect(createOrderSpy).not.toHaveBeenCalled();

      // Step 2: Administrator approves the request
      const approveRes = await fetch(`${baseUrl}/api/approvals/${approvalId}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decidedBy: 'admin@paypilot.internal' }),
      });
      expect(approveRes.status).toBe(200);
      expect(createOrderSpy).not.toHaveBeenCalled();

      // Step 3: Buyer checkout calls /api/orders passing orderInternalId and approvalRequestId
      const firstCreateRes = await fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: 'demo-headphones',
          quantity: 3,
          checkoutAttemptId: randomUUID(),
          orderInternalId: checkoutAttemptId,
          approvalRequestId: approvalId,
        }),
      });

      expect(firstCreateRes.status).toBe(201);
      const firstData = await firstCreateRes.json();
      expect(firstData.orderId).toBe('PAYPAL_ORDER_APPROVED_FLOW');
      // PayPal createOrder called exactly once
      expect(createOrderSpy).toHaveBeenCalledTimes(1);

      // Verify stored order is updated in place
      const storedOrdersAfterFirst = await OrderModel.find({ internalId: checkoutAttemptId });
      expect(storedOrdersAfterFirst).toHaveLength(1);
      expect(storedOrdersAfterFirst[0].status).toBe('CREATED');
      expect(storedOrdersAfterFirst[0].paypalOrderId).toBe('PAYPAL_ORDER_APPROVED_FLOW');

      // Step 4: Second create for the same approved order does not call PayPal again and does not create duplicate
      const secondCreateRes = await fetch(`${baseUrl}/api/orders`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          productId: 'demo-headphones',
          quantity: 3,
          checkoutAttemptId: randomUUID(),
          orderInternalId: checkoutAttemptId,
          approvalRequestId: approvalId,
        }),
      });

      expect(secondCreateRes.status).toBe(201);
      const secondData = await secondCreateRes.json();
      expect(secondData.orderId).toBe('PAYPAL_ORDER_APPROVED_FLOW');

      // Crucial: PayPal createOrder was STILL called only once (not duplicated)
      expect(createOrderSpy).toHaveBeenCalledTimes(1);

      // Crucial: Database still has exactly 1 order for that approval, no duplicate order document
      const storedOrdersAfterSecond = await OrderModel.find({ internalId: checkoutAttemptId });
      expect(storedOrdersAfterSecond).toHaveLength(1);
      const totalOrderCount = await OrderModel.countDocuments();
      expect(totalOrderCount).toBe(1);
    });
  });

  describe('PayPilot Transactions & Audit Log API', () => {
    it('GET /api/transactions returns stored orders and GET /api/transactions/summary computes monthly metrics from stored records only', async () => {
      // Seed test orders with various statuses
      await OrderModel.create([
        {
          internalId: 'ORDER_1',
          paypalOrderId: 'PAYPAL_1',
          status: 'COMPLETED',
          productId: 'demo-headphones',
          quantity: 1,
          amount: 49.99,
          currency: 'USD',
          captureId: 'CAP_1',
          createdAt: new Date(),
        },
        {
          internalId: 'ORDER_2',
          paypalOrderId: 'PAYPAL_2',
          status: 'COMPLETED',
          productId: 'demo-headphones',
          quantity: 2,
          amount: 99.98,
          currency: 'USD',
          captureId: 'CAP_2',
          createdAt: new Date(),
        },
        {
          internalId: 'ORDER_3',
          status: 'PENDING_APPROVAL',
          productId: 'demo-headphones',
          quantity: 3,
          amount: 149.97,
          currency: 'USD',
          createdAt: new Date(),
        },
      ]);

      // GET /api/transactions
      const listRes = await fetch(`${baseUrl}/api/transactions`);
      expect(listRes.status).toBe(200);
      const transactions = await listRes.json();
      expect(transactions.length).toBe(3);

      // GET /api/transactions?status=COMPLETED
      const completedRes = await fetch(`${baseUrl}/api/transactions?status=COMPLETED`);
      expect(completedRes.status).toBe(200);
      const completedList = await completedRes.json();
      expect(completedList.length).toBe(2);

      // GET /api/transactions/summary
      const summaryRes = await fetch(`${baseUrl}/api/transactions/summary`);
      expect(summaryRes.status).toBe(200);
      const summary = await summaryRes.json();

      expect(summary.totalOrders).toBe(3);
      expect(summary.totalVolume).toBe(299.94);
      expect(summary.countsByStatus.COMPLETED).toBe(2);
      expect(summary.totalsByStatus.COMPLETED).toBe(149.97);
      expect(summary.countsByStatus.PENDING_APPROVAL).toBe(1);
      expect(summary.totalsByStatus.PENDING_APPROVAL).toBe(149.97);
    });

    it('GET /api/audit returns rows in newest-first order with default and max limits', async () => {
      await AuditLogModel.create([
        {
          action: 'ACTION_FIRST',
          actor: 'SYSTEM',
          entityType: 'Order',
          entityId: 'ID_1',
          createdAt: new Date(Date.now() - 3000),
        },
        {
          action: 'ACTION_MIDDLE',
          actor: 'ADMIN',
          entityType: 'ApprovalRequest',
          entityId: 'ID_2',
          createdAt: new Date(Date.now() - 2000),
        },
        {
          action: 'ACTION_LATEST',
          actor: 'BUYER',
          entityType: 'Order',
          entityId: 'ID_3',
          createdAt: new Date(Date.now() - 1000),
        },
      ]);

      const res = await fetch(`${baseUrl}/api/audit?limit=2`);
      expect(res.status).toBe(200);
      const logs = await res.json();
      expect(logs.length).toBe(2);
      // Newest first order
      expect(logs[0].action).toBe('ACTION_LATEST');
      expect(logs[1].action).toBe('ACTION_MIDDLE');
    });
  });
});

