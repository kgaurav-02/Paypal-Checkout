import { describe, expect, it } from 'vitest';
import { evaluateOrder } from '../src/services/approvalPolicy';

describe('Approval Policy Service (evaluateOrder)', () => {
  const MAX_LIMIT = 100;

  it('allows orders below limit', () => {
    const result = evaluateOrder(49.99, MAX_LIMIT);
    expect(result.decision).toBe('allowed');
    expect(result.reason).toContain('within the automated approval limit');
  });

  it('allows orders exactly equal to limit', () => {
    const result = evaluateOrder(100.0, MAX_LIMIT);
    expect(result.decision).toBe('allowed');
    expect(result.reason).toContain('within the automated approval limit');
  });

  it('requires approval for orders above limit', () => {
    const result = evaluateOrder(100.01, MAX_LIMIT);
    expect(result.decision).toBe('approval_required');
    expect(result.reason).toContain('exceeds the automated approval limit');
  });

  describe('handles invalid amounts by requiring approval', () => {
    it('requires approval for zero amount', () => {
      const result = evaluateOrder(0, MAX_LIMIT);
      expect(result.decision).toBe('approval_required');
      expect(result.reason).toContain('invalid');
    });

    it('requires approval for negative amount', () => {
      const result = evaluateOrder(-25.5, MAX_LIMIT);
      expect(result.decision).toBe('approval_required');
      expect(result.reason).toContain('invalid');
    });

    it('requires approval for NaN', () => {
      const result = evaluateOrder(NaN, MAX_LIMIT);
      expect(result.decision).toBe('approval_required');
      expect(result.reason).toContain('invalid');
    });

    it('requires approval for non-finite amount', () => {
      const result = evaluateOrder(Infinity, MAX_LIMIT);
      expect(result.decision).toBe('approval_required');
      expect(result.reason).toContain('invalid');
    });
  });
});

