import { randomUUID } from 'crypto';
import http from 'http';
import { AddressInfo } from 'net';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, it } from 'vitest';
import app from '../src/app';
import { connectDB, disconnectDB } from '../src/db/connect';
import { financialPolicyRepository } from '../src/repositories/financialPolicyRepository';

describe('Manual Check - Guardian End-to-End Approval Flow', () => {
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

  it('performs end-to-end manual verification flow', async () => {
    console.log('\n--- MANUAL CHECK STEP 1: Place a quantity 3 order ---');
    const checkoutAttemptId = randomUUID();
    const orderPayload = {
      productId: 'demo-headphones',
      quantity: 3,
      checkoutAttemptId,
    };
    console.log('Sending POST /api/orders with payload:', JSON.stringify(orderPayload, null, 2));

    const orderRes = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(orderPayload),
    });

    const orderBody = await orderRes.json();
    console.log(`Response Status: HTTP ${orderRes.status}`);
    console.log('Response Body:', JSON.stringify(orderBody, null, 2));

    const approvalRequestId = orderBody.approvalRequestId;
    console.log(`Generated Approval Request ID: ${approvalRequestId}`);

    console.log('\n--- MANUAL CHECK STEP 2: Confirm it shows in pending approvals ---');
    const pendingRes = await fetch(`${baseUrl}/api/approvals?status=PENDING`);
    const pendingList = await pendingRes.json();
    console.log(`Response Status: HTTP ${pendingRes.status}`);
    console.log('Pending Approvals Count:', pendingList.length);
    console.log('Pending Approvals List:', JSON.stringify(pendingList, null, 2));

    console.log('\n--- MANUAL CHECK STEP 3: Approve it ---');
    const approvePayload = { decidedBy: 'compliance-officer@paypilot.internal' };
    const approveRes = await fetch(`${baseUrl}/api/approvals/${approvalRequestId}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(approvePayload),
    });
    const approveBody = await approveRes.json();
    console.log(`Response Status: HTTP ${approveRes.status}`);
    console.log('Approve Response Body:', JSON.stringify(approveBody, null, 2));

    console.log('\n--- MANUAL CHECK STEP 4: Confirm audit log shows both events ---');
    const auditRes = await fetch(`${baseUrl}/api/audit?limit=10`);
    const auditLogs = await auditRes.json();
    console.log(`Response Status: HTTP ${auditRes.status}`);
    console.log('Audit Logs Returned:', auditLogs.length);
    console.log('Audit Log Entries:');
    auditLogs.forEach((log: any, idx: number) => {
      console.log(` [${idx + 1}] Action: ${log.action} | Actor: ${log.actor} | Entity: ${log.entityType}#${log.entityId} | Time: ${log.createdAt}`);
    });

    console.log('\n--- MANUAL CHECK STEP 5: Confirm pending approvals list is now empty ---');
    const afterPendingRes = await fetch(`${baseUrl}/api/approvals?status=PENDING`);
    const afterPendingList = await afterPendingRes.json();
    console.log('Remaining Pending Approvals Count:', afterPendingList.length);
  });
});

