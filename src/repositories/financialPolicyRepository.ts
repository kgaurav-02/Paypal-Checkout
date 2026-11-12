import { FinancialPolicyModel, IFinancialPolicy } from '../models/FinancialPolicy';

export class FinancialPolicyRepository {
  /**
   * Retrieves the currently active financial policy.
   */
  async getActivePolicy(): Promise<IFinancialPolicy | null> {
    return await FinancialPolicyModel.findOne({ active: true }).sort({ createdAt: -1 });
  }

  /**
   * Seeds a default policy from configured MAX_AMOUNT if no active policy exists.
   */
  async seedDefaultPolicy(defaultMaxAmount: number): Promise<IFinancialPolicy> {
    const existing = await this.getActivePolicy();
    if (existing) {
      return existing;
    }

    const defaultPolicy = new FinancialPolicyModel({
      name: 'Default Financial Policy',
      maxAmount: defaultMaxAmount,
      currency: 'USD',
      requiresApprovalAbove: defaultMaxAmount,
      active: true,
    });

    return await defaultPolicy.save();
  }

  /**
   * Creates a new financial policy.
   */
  async createPolicy(data: {
    name: string;
    maxAmount: number;
    currency?: string;
    requiresApprovalAbove: number;
    active?: boolean;
  }): Promise<IFinancialPolicy> {
    if (data.active) {
      // Deactivate older policies if new one is active
      await FinancialPolicyModel.updateMany({ active: true }, { $set: { active: false } });
    }

    const policy = new FinancialPolicyModel({
      name: data.name,
      maxAmount: data.maxAmount,
      currency: data.currency || 'USD',
      requiresApprovalAbove: data.requiresApprovalAbove,
      active: data.active ?? true,
    });

    return await policy.save();
  }
}

export const financialPolicyRepository = new FinancialPolicyRepository();

