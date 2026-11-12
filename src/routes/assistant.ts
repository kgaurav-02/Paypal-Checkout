import { Request, Response, Router } from 'express';
import { z } from 'zod';
import { routeUserMessage } from '../ai/router';

export const assistantRouter = Router();

const messageSchema = z.object({
  message: z.string({ required_error: 'message is required' }).min(1, 'message cannot be empty'),
});

assistantRouter.post('/', async (req: Request, res: Response) => {
  const parseResult = messageSchema.safeParse(req.body);
  if (!parseResult.success) {
    res.status(400).json({
      error: {
        code: 'INVALID_INPUT',
        message: parseResult.error.errors[0]?.message || 'Invalid input',
      },
    });
    return;
  }

  try {
    const response = await routeUserMessage(parseResult.data.message);
    res.json(response);
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    res.status(500).json({
      error: {
        code: 'ASSISTANT_ERROR',
        message: `Failed to process assistant request: ${errorMsg}`,
      },
    });
  }
});

