import { NextFunction, Request, Response, Router } from 'express';
import { ValidationError } from '../errors/paypalErrors';
import { clientsRepository, createClientSchema } from '../repositories/clientsRepository';

const router = Router();

/**
 * POST /api/clients
 * Creates a new client.
 */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parseResult = createClientSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError(parseResult.error.issues[0].message);
    }

    const existing = await clientsRepository.findClientByEmail(parseResult.data.email);
    if (existing) {
      res.status(409).json({
        error: {
          code: 'CLIENT_ALREADY_EXISTS',
          message: `A client with email ${parseResult.data.email} already exists`,
        },
      });
      return;
    }

    const client = await clientsRepository.createClient(parseResult.data);
    res.status(201).json(client);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/clients
 * Lists all clients.
 */
router.get('/', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const clients = await clientsRepository.listClients();
    res.status(200).json(clients);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/clients/:id
 * Fetches client by ID.
 */
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = req.params.id as string;
    const client = await clientsRepository.findClientById(clientId);
    if (!client) {
      res.status(404).json({
        error: {
          code: 'CLIENT_NOT_FOUND',
          message: `Client not found with ID ${clientId}`,
        },
      });
      return;
    }
    res.status(200).json(client);
  } catch (err) {
    next(err);
  }
});

export default router;
