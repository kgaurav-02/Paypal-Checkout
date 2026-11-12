import { IRiskReason, RiskClassification } from '../../models/RiskAssessment';
import {
  checkAmountSpike,
  checkMidnightHours,
  checkNonUsdCurrency,
  checkOrderVelocity,
  checkRepeatedFailures,
  OrderRecord,
  RuleEvaluationResult,
} from './rules';

export interface RiskEvaluation {
  score: number;
  classification: RiskClassification;
  reasons: IRiskReason[];
  recommendedAction: string;
}

/**
 * Maps a numerical score (0 - 100) to a standard risk classification.
 * Boundaries:
 *  0 - 29:  LOW
 * 30 - 59:  MODERATE
 * 60 - 79:  HIGH
 * 80 - 100: CRITICAL
 */
export function classifyScore(score: number): RiskClassification {
  const boundedScore = Math.min(Math.max(Math.round(score), 0), 100);

  if (boundedScore <= 29) {
    return 'LOW';
  }
  if (boundedScore <= 59) {
    return 'MODERATE';
  }
  if (boundedScore <= 79) {
    return 'HIGH';
  }
  return 'CRITICAL';
}

/**
 * Determines recommended action based on risk classification.
 */
export function getRecommendedAction(classification: RiskClassification): string {
  switch (classification) {
    case 'LOW':
      return 'APPROVE_AUTOMATICALLY';
    case 'MODERATE':
      return 'MONITOR';
    case 'HIGH':
      return 'ADMINISTRATIVE_REVIEW_REQUIRED';
    case 'CRITICAL':
      return 'ADMINISTRATIVE_BLOCK_RECOMMENDED';
  }
}

/**
 * Evaluates an order against all FraudShield rules and computes an aggregated risk score.
 */
export function evaluateRisk(
  currentOrder: OrderRecord,
  history: OrderRecord[] = [],
  serverTime?: Date
): RiskEvaluation {
  const ruleResults: RuleEvaluationResult[] = [
    checkAmountSpike(currentOrder, history),
    checkOrderVelocity(currentOrder, history, serverTime),
    checkMidnightHours(currentOrder, serverTime),
    checkRepeatedFailures(currentOrder, history, serverTime),
    checkNonUsdCurrency(currentOrder),
  ];

  let totalScore = 0;
  const reasons: IRiskReason[] = [];

  for (const res of ruleResults) {
    if (res.triggered) {
      totalScore += res.weight;
      reasons.push({
        rule: res.rule,
        detail: res.detail,
        scoreContribution: res.weight,
      });
    }
  }

  // Cap aggregate score at 100
  const finalScore = Math.min(totalScore, 100);
  const classification = classifyScore(finalScore);
  const recommendedAction = getRecommendedAction(classification);

  return {
    score: finalScore,
    classification,
    reasons,
    recommendedAction,
  };
}

