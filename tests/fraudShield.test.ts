import http from 'http';
import { AddressInfo } from 'net';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import app from '../src/app';
import { connectDB, disconnectDB } from '../src/db/connect';
import { ApprovalRequestModel } from '../src/models/ApprovalRequest';
import { AuditLogModel } from '../src/models/AuditLog';
import { OrderModel } from '../src/models/Order';
import { RiskAssessmentModel } from '../src/models/RiskAssessment';
import { financialPolicyRepository } from '../src/repositories/financialPolicyRepository';
import {
  checkAmountSpike,
  checkMidnightHours,
  checkNonUsdCurrency,
  checkOrderVelocity,
  checkRepeatedFailures,
} from '../src/services/fraudShield/rules';
import { classifyScore, evaluateRisk } from '../src/services/fraudShield/score';

describe('FraudShield Rule Engine & Scoring System', () => {
  describe('Rule Functions in Isolation', () => {
    it('checkAmountSpike: triggers only when amount > 2x buyer historical average', () => {
      const history = [
        { internalId: 'O1', amount: 50, currency: 'USD', status: 'COMPLETED' },
        { internalId: 'O2', amount: 50, currency: 'USD', status: 'COMPLETED' },
      ]; // Average = 50, 2x Threshold = 100

      // Order below 2x threshold
      const resNormal = checkAmountSpike(
        { internalId: 'O3', amount: 99.99, currency: 'USD' },
        history
      );
      expect(resNormal.triggered).toBe(false);

      // Order exceeding 2x threshold
      const resSpike = checkAmountSpike(
        { internalId: 'O4', amount: 101.0, currency: 'USD' },
        history
      );
      expect(resSpike.triggered).toBe(true);
      expect(resSpike.weight).toBe(30);

      // Order with no history never triggers amount spike
      const resNoHistory = checkAmountSpike(
        { internalId: 'O5', amount: 500.0, currency: 'USD' },
        []
      );
      expect(resNoHistory.triggered).toBe(false);
    });

    it('checkOrderVelocity: triggers when more than 3 orders placed in 10 minutes', () => {
      const now = new Date('2026-11-11T12:00:00Z');

      // 3 orders in last 10 minutes (within acceptable limit)
      const normalHistory = [
        { internalId: 'V1', amount: 50, currency: 'USD', createdAt: new Date('2026-11-11T11:55:00Z') },
        { internalId: 'V2', amount: 50, currency: 'USD', createdAt: new Date('2026-11-11T11:56:00Z') },
        { internalId: 'V3', amount: 50, currency: 'USD', createdAt: new Date('2026-11-11T11:58:00Z') },
      ];
      const resNormal = checkOrderVelocity(
        { internalId: 'V4', amount: 50, currency: 'USD', createdAt: now },
        normalHistory,
        now
      );
      expect(resNormal.triggered).toBe(false);

      // 4 orders in last 10 minutes (> 3 limit exceeded)
      const rapidHistory = [
        ...normalHistory,
        { internalId: 'V5', amount: 50, currency: 'USD', createdAt: new Date('2026-11-11T11:59:00Z') },
      ];
      const resRapid = checkOrderVelocity(
        { internalId: 'V6', amount: 50, currency: 'USD', createdAt: now },
        rapidHistory,
        now
      );
      expect(resRapid.triggered).toBe(true);
      expect(resRapid.weight).toBe(30);
    });

    it('checkMidnightHours: triggers between 00:00 and 05:00 server time', () => {
      // 02:30 AM (High risk window)
      const midnightTime = new Date('2026-11-11T02:30:00');
      const resMidnight = checkMidnightHours(
        { internalId: 'M1', amount: 50, currency: 'USD' },
        midnightTime
      );
      expect(resMidnight.triggered).toBe(true);
      expect(resMidnight.weight).toBe(15);

      // 14:30 PM (Normal business hours)
      const afternoonTime = new Date('2026-11-11T14:30:00');
      const resDay = checkMidnightHours(
        { internalId: 'M2', amount: 50, currency: 'USD' },
        afternoonTime
      );
      expect(resDay.triggered).toBe(false);
    });

    it('checkRepeatedFailures: triggers when 2 or more failed/cancelled orders in the last hour', () => {
      const now = new Date('2026-11-11T12:00:00Z');

      // 1 failure within 1 hour
      const oneFailure = [
        { internalId: 'F1', amount: 50, currency: 'USD', status: 'FAILED', createdAt: new Date('2026-11-11T11:45:00Z') },
      ];
      const resOne = checkRepeatedFailures(
        { internalId: 'F2', amount: 50, currency: 'USD', createdAt: now },
        oneFailure,
        now
      );
      expect(resOne.triggered).toBe(false);

      // 2 failures within 1 hour
      const twoFailures = [
        ...oneFailure,
        { internalId: 'F3', amount: 50, currency: 'USD', status: 'REJECTED', createdAt: new Date('2026-11-11T11:50:00Z') },
      ];
      const resTwo = checkRepeatedFailures(
        { internalId: 'F4', amount: 50, currency: 'USD', createdAt: now },
        twoFailures,
        now
      );
      expect(resTwo.triggered).toBe(true);
      expect(resTwo.weight).toBe(25);
    });

    it('checkNonUsdCurrency: triggers on non-USD currency', () => {
      expect(checkNonUsdCurrency({ internalId: 'C1', amount: 50, currency: 'USD' }).triggered).toBe(false);
      expect(checkNonUsdCurrency({ internalId: 'C2', amount: 50, currency: 'usd' }).triggered).toBe(false);

      const resEur = checkNonUsdCurrency({ internalId: 'C3', amount: 50, currency: 'EUR' });
      expect(resEur.triggered).toBe(true);
      expect(resEur.weight).toBe(25);
    });
  });

  describe('Score Boundaries and Classifications', () => {
    it('correctly maps scores to boundaries 29/30, 59/60, and 79/80', () => {
      // 0 - 29: LOW
      expect(classifyScore(0)).toBe('LOW');
      expect(classifyScore(29)).toBe('LOW');

      // 30 - 59: MODERATE
      expect(classifyScore(30)).toBe('MODERATE');
      expect(classifyScore(59)).toBe('MODERATE');

      // 60 - 79: HIGH
      expect(classifyScore(60)).toBe('HIGH');
      expect(classifyScore(79)).toBe('HIGH');

      // 80 - 100: CRITICAL
      expect(classifyScore(80)).toBe('CRITICAL');
      expect(classifyScore(100)).toBe('CRITICAL');
    });

    it('an order with no history evaluates to LOW', () => {
      const regularTime = new Date('2026-11-11T14:00:00');
      const result = evaluateRisk(
        {
          internalId: 'CLEAN_ORDER',
          amount: 49.99,
          currency: 'USD',
          createdAt: regularTime,
        },
        [],
        regularTime
      );

      expect(result.score).toBe(0);
      expect(result.classification).toBe('LOW');
      expect(result.recommendedAction).toBe('APPROVE_AUTOMATICALLY');
      expect(result.reasons.length).toBe(0);
    });
  });

  describe('Risk API Endpoints (/api/risk)', () => {
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
      await RiskAssessmentModel.deleteMany({});
      await OrderModel.deleteMany({});
      await ApprovalRequestModel.deleteMany({});
      await AuditLogModel.deleteMany({});
    });

    it('GET /api/risk/assessments and /api/risk/summary return computed metrics strictly from stored records', async () => {
      // Seed stored assessments
      await RiskAssessmentModel.create([
        {
          orderInternalId: 'ORD_LOW_1',
          score: 15,
          classification: 'LOW',
          reasons: [{ rule: 'HIGH_RISK_OVERNIGHT_HOURS', detail: 'Overnight order' }],
          recommendedAction: 'APPROVE_AUTOMATICALLY',
        },
        {
          orderInternalId: 'ORD_MOD_1',
          score: 30,
          classification: 'MODERATE',
          reasons: [{ rule: 'AMOUNT_SPIKE_2X_AVERAGE', detail: 'Spike' }],
          recommendedAction: 'MONITOR',
        },
        {
          orderInternalId: 'ORD_HIGH_1',
          score: 70,
          classification: 'HIGH',
          reasons: [
            { rule: 'AMOUNT_SPIKE_2X_AVERAGE', detail: 'Spike' },
            { rule: 'RAPID_ORDER_VELOCITY', detail: 'Velocity' },
          ],
          recommendedAction: 'ADMINISTRATIVE_REVIEW_REQUIRED',
        },
      ]);

      // 1. GET /api/risk/summary
      const summaryRes = await fetch(`${baseUrl}/api/risk/summary`);
      expect(summaryRes.status).toBe(200);
      const summary = await summaryRes.json();
      expect(summary.totalAssessed).toBe(3);
      expect(summary.countsByClassification.LOW).toBe(1);
      expect(summary.countsByClassification.MODERATE).toBe(1);
      expect(summary.countsByClassification.HIGH).toBe(1);
      expect(summary.countsByClassification.CRITICAL).toBe(0);

      // 2. GET /api/risk/assessments?classification=HIGH
      const highRes = await fetch(`${baseUrl}/api/risk/assessments?classification=HIGH`);
      expect(highRes.status).toBe(200);
      const highList = await highRes.json();
      expect(highList.length).toBe(1);
      expect(highList[0].orderInternalId).toBe('ORD_HIGH_1');

      // 3. GET /api/risk/assessments/:orderId
      const singleRes = await fetch(`${baseUrl}/api/risk/assessments/ORD_MOD_1`);
      expect(singleRes.status).toBe(200);
      const single = await singleRes.json();
      expect(single.score).toBe(30);
      expect(single.classification).toBe('MODERATE');
    });
  });
});

