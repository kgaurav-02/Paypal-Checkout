import {
  IRiskAssessment,
  IRiskReason,
  RiskAssessmentModel,
  RiskClassification,
} from '../models/RiskAssessment';

export interface CreateRiskAssessmentDTO {
  orderInternalId: string;
  score: number;
  classification: RiskClassification;
  reasons: IRiskReason[];
  recommendedAction: string;
  assessedAt?: Date;
}

export interface RiskSummaryResult {
  totalAssessed: number;
  countsByClassification: {
    LOW: number;
    MODERATE: number;
    HIGH: number;
    CRITICAL: number;
  };
}

export class RiskAssessmentRepository {
  /**
   * Persists a risk assessment for an order.
   */
  async saveAssessment(data: CreateRiskAssessmentDTO): Promise<IRiskAssessment> {
    const assessment = await RiskAssessmentModel.findOneAndUpdate(
      { orderInternalId: data.orderInternalId },
      {
        $set: {
          orderInternalId: data.orderInternalId,
          score: data.score,
          classification: data.classification,
          reasons: data.reasons,
          recommendedAction: data.recommendedAction,
          assessedAt: data.assessedAt || new Date(),
        },
      },
      {
        upsert: true,
        returnDocument: 'after',
        runValidators: true,
      }
    );

    return assessment;
  }

  /**
   * Finds a risk assessment by orderInternalId.
   */
  async findByOrderInternalId(orderInternalId: string): Promise<IRiskAssessment | null> {
    return await RiskAssessmentModel.findOne({ orderInternalId });
  }

  /**
   * Lists risk assessments, optionally filtered by classification (newest first).
   */
  async listAssessments(
    filter?: { classification?: RiskClassification },
    limit: number = 50
  ): Promise<IRiskAssessment[]> {
    const query: Record<string, any> = {};
    if (filter?.classification) {
      query.classification = filter.classification;
    }
    const safeLimit = Math.min(Math.max(limit, 1), 200);
    return await RiskAssessmentModel.find(query).sort({ assessedAt: -1 }).limit(safeLimit);
  }

  /**
   * Computes classification counts strictly from stored risk assessments.
   */
  async getRiskSummary(): Promise<RiskSummaryResult> {
    const assessments = await RiskAssessmentModel.find({});

    const counts = {
      LOW: 0,
      MODERATE: 0,
      HIGH: 0,
      CRITICAL: 0,
    };

    for (const item of assessments) {
      if (item.classification in counts) {
        counts[item.classification]++;
      }
    }

    return {
      totalAssessed: assessments.length,
      countsByClassification: counts,
    };
  }
}

export const riskAssessmentRepository = new RiskAssessmentRepository();

