import { NextFunction, Request, Response, Router } from 'express';
import { riskAssessmentRepository } from '../repositories/riskAssessmentRepository';

const router = Router();

/**
 * GET /api/risk/summary
 * Returns counts by risk classification computed strictly from stored assessments.
 */
router.get('/summary', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const summary = await riskAssessmentRepository.getRiskSummary();
    res.status(200).json(summary);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/risk/assessments
 * Lists recent risk assessments, optionally filtered by ?classification=.
 */
router.get('/assessments', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const classification = req.query.classification as any;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 50;

    const assessments = await riskAssessmentRepository.listAssessments(
      { classification },
      limit
    );
    res.status(200).json(assessments);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/risk/assessments/:orderId
 * Fetches risk assessment for a specific order.
 */
router.get('/assessments/:orderId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const orderId = req.params.orderId as string;
    const assessment = await riskAssessmentRepository.findByOrderInternalId(orderId);
    if (!assessment) {
      res.status(404).json({
        error: {
          code: 'ASSESSMENT_NOT_FOUND',
          message: `Risk assessment not found for order ${orderId}`,
        },
      });
      return;
    }
    res.status(200).json(assessment);
  } catch (err) {
    next(err);
  }
});

export default router;

