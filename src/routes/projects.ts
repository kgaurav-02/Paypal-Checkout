import { NextFunction, Request, Response, Router } from 'express';
import { ValidationError } from '../errors/paypalErrors';
import { clientsRepository } from '../repositories/clientsRepository';
import { createProjectSchema, projectsRepository } from '../repositories/projectsRepository';

const router = Router();

/**
 * POST /api/projects
 * Creates a project associated with a client.
 */
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parseResult = createProjectSchema.safeParse(req.body);
    if (!parseResult.success) {
      throw new ValidationError(parseResult.error.issues[0].message);
    }

    const client = await clientsRepository.findClientById(parseResult.data.clientId);
    if (!client) {
      res.status(404).json({
        error: {
          code: 'CLIENT_NOT_FOUND',
          message: `Cannot create project: Client not found with ID ${parseResult.data.clientId}`,
        },
      });
      return;
    }

    const project = await projectsRepository.createProject(parseResult.data);
    res.status(201).json(project);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/projects
 * Lists projects, optionally filtered by ?clientId=.
 */
router.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const clientId = req.query.clientId as string | undefined;
    const status = req.query.status as any;
    const projects = await projectsRepository.listProjects({ clientId, status });
    res.status(200).json(projects);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/projects/:id
 * Fetches project by ID.
 */
router.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const projectId = req.params.id as string;
    const project = await projectsRepository.findProjectById(projectId);
    if (!project) {
      res.status(404).json({
        error: {
          code: 'PROJECT_NOT_FOUND',
          message: `Project not found with ID ${projectId}`,
        },
      });
      return;
    }
    res.status(200).json(project);
  } catch (err) {
    next(err);
  }
});

export default router;
