import { randomUUID } from 'crypto';
import http from 'http';
import { AddressInfo } from 'net';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, beforeAll, describe, it, vi } from 'vitest';
import app from '../src/app';
import { connectDB, disconnectDB } from '../src/db/connect';
import { financialPolicyRepository } from '../src/repositories/financialPolicyRepository';
import * as paypalClient from '../src/services/paypalClient';

describe('Phase 7 Manual Check (FreelancerPay & FraudShield)', () => {
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

  it('performs Phase 7 live end-to-end manual verification', async () => {
    console.log('\n--- PHASE 7 MANUAL CHECK 1: Create a client ---');
    const clientPayload = {
      name: 'Acme Studio Design',
      email: 'billing@acmestudio.com',
      company: 'Acme Studio LLC',
    };
    console.log('Sending POST /api/clients with payload:', JSON.stringify(clientPayload, null, 2));

    const clientRes = await fetch(`${baseUrl}/api/clients`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(clientPayload),
    });
    const clientData = await clientRes.json();
    console.log(`Response Status: HTTP ${clientRes.status}`);
    console.log('Client Created:', JSON.stringify(clientData, null, 2));

    const clientId = clientData._id;

    console.log('\n--- PHASE 7 MANUAL CHECK 2: Create a $50 invoice ---');
    const inv50Payload = {
      clientId,
      items: [{ description: 'Logo Design & Asset Export', quantity: 1, unitPrice: 50.0 }],
      dueDate: new Date(Date.now() + 7 * 86400000).toISOString(),
    };
    console.log('Sending POST /api/invoices ($50.00) with payload:', JSON.stringify(inv50Payload, null, 2));

    const inv50Res = await fetch(`${baseUrl}/api/invoices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(inv50Payload),
    });
    const inv50Data = await inv50Res.json();
    console.log(`Response Status: HTTP ${inv50Res.status}`);
    console.log('Invoice ($50) Result:', JSON.stringify(inv50Data, null, 2));

    console.log('\n--- PHASE 7 MANUAL CHECK 3: Create a $2,000 invoice (Exceeds Policy Limit) ---');
    const inv2000Payload = {
      clientId,
      items: [{ description: 'Full Platform Architecture & Redesign', quantity: 1, unitPrice: 2000.0 }],
      dueDate: new Date(Date.now() + 14 * 86400000).toISOString(),
    };
    console.log('Sending POST /api/invoices ($2000.00) with payload:', JSON.stringify(inv2000Payload, null, 2));

    const inv2000Res = await fetch(`${baseUrl}/api/invoices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(inv2000Payload),
    });
    const inv2000Data = await inv2000Res.json();
    console.log(`Response Status: HTTP ${inv2000Res.status}`);
    console.log('Invoice ($2,000) Result:', JSON.stringify(inv2000Data, null, 2));

    // Confirm that $2,000 invoice waits for approval
    console.log('\nVerifying that $2,000 invoice waits for approval...');
    const inv2000Id = inv2000Data.invoice.internalId;
    const sendBlockedRes = await fetch(`${baseUrl}/api/invoices/${inv2000Id}/send`, { method: 'POST' });
    const sendBlockedData = await sendBlockedRes.json();
    console.log(`Attempt to send before approval HTTP Status: ${sendBlockedRes.status}`);
    console.log('Block Reason:', JSON.stringify(sendBlockedData, null, 2));

    console.log('\n--- PHASE 7 MANUAL CHECK 4: Check an order and its FraudShield risk assessment ---');
    vi.spyOn(paypalClient, 'createOrder').mockResolvedValue({
      orderId: 'MOCK_PAYPAL_ORDER_PHASE7',
      status: 'CREATED',
    });

    const orderAttemptId = randomUUID();
    const orderRes = await fetch(`${baseUrl}/api/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        productId: 'demo-headphones',
        quantity: 1, // $49.99
        checkoutAttemptId: orderAttemptId,
      }),
    });
    console.log(`Order Creation HTTP Status: ${orderRes.status}`);

    const riskRes = await fetch(`${baseUrl}/api/risk/assessments/${orderAttemptId}`);
    const riskData = await riskRes.json();
    console.log(`Risk Assessment Fetch HTTP Status: ${riskRes.status}`);
    console.log('Risk Assessment Data:', JSON.stringify(riskData, null, 2));
  });
});

