import { z } from 'zod';
import { IProject, ProjectModel, ProjectStatus } from '../models/Project';

export const createProjectSchema = z.object({
  clientId: z.string({ required_error: 'clientId is required' }).min(1, 'clientId cannot be empty'),
  name: z.string({ required_error: 'name is required' }).trim().min(1, 'name cannot be empty'),
  description: z.string({ required_error: 'description is required' }).trim().min(1, 'description cannot be empty'),
  budget: z
    .number({ required_error: 'budget is required' })
    .min(0, 'budget must be non-negative'),
  currency: z.string().default('USD'),
  deadline: z.coerce.date().optional(),
  status: z.enum(['ACTIVE', 'COMPLETED', 'ARCHIVED']).default('ACTIVE'),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export class ProjectsRepository {
  async createProject(data: CreateProjectInput): Promise<IProject> {
    const validated = createProjectSchema.parse(data);
    const project = new ProjectModel(validated);
    return await project.save();
  }

  async listProjects(filter?: { clientId?: string; status?: ProjectStatus }): Promise<IProject[]> {
    const query: Record<string, any> = {};
    if (filter?.clientId) {
      query.clientId = filter.clientId;
    }
    if (filter?.status) {
      query.status = filter.status;
    }
    return await ProjectModel.find(query).sort({ createdAt: -1 });
  }

  async findProjectById(id: string): Promise<IProject | null> {
    return await ProjectModel.findById(id);
  }
}

export const projectsRepository = new ProjectsRepository();

