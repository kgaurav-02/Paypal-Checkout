import { describe, it } from 'vitest';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../.env') });

describe('PayPal Invoicing API Probe (Sandbox Account Capability Check)', () => {
  it('calls POST /v2/invoicing/invoices with sandbox credentials and reports response', async () => {
    const clientId = process.env.PAYPAL_CLIENT_ID;
    const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

    console.log('1. Fetching OAuth2 Bearer Token from PayPal Sandbox...');
    const authHeader = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const tokenRes = await fetch('https://api-m.sandbox.paypal.com/v1/oauth2/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${authHeader}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });

    const tokenData = await tokenRes.json();
    console.log(`OAuth2 Token HTTP Status: ${tokenRes.status}`);
    console.log('Granted Scopes:');
    console.log(tokenData.scope || '(none)');

    const accessToken = tokenData.access_token;

    console.log('\n2. Calling PayPal Invoicing v2 API (POST /v2/invoicing/invoices)...');
    const invoicePayload = {
      detail: {
        invoice_number: `INV-${Date.now().toString().slice(-6)}`,
        reference: 'PAYPILOT-PROBE-001',
        invoice_date: new Date().toISOString().split('T')[0],
        currency_code: 'USD',
        note: 'Thank you for your business.',
      },
      invoicer: {
        name: {
          given_name: 'PayPilot',
          surname: 'Freelancer',
        },
      },
      primary_recipients: [
        {
          billing_info: {
            name: {
              given_name: 'Test',
              surname: 'Client',
            },
            email_address: 'client-test@example.com',
          },
        },
      ],
      items: [
        {
          name: 'Web Application Development',
          description: 'Software development services',
          quantity: '1',
          unit_amount: {
            currency_code: 'USD',
            value: '50.00',
          },
        },
      ],
    };

    const invoiceRes = await fetch('https://api-m.sandbox.paypal.com/v2/invoicing/invoices', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'PayPal-Request-Id': `probe-${Date.now()}`,
      },
      body: JSON.stringify(invoicePayload),
    });

    const invoiceBody = await invoiceRes.json();
    console.log(`\nPayPal Invoicing API Response: HTTP ${invoiceRes.status} ${invoiceRes.statusText}`);
    console.log('Response Body:');
    console.log(JSON.stringify(invoiceBody, null, 2));
  }, 30000);
});

