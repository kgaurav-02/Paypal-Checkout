import { z } from 'zod';
import { ClientModel, IClient } from '../models/Client';

export const createClientSchema = z.object({
  name: z.string({ required_error: 'name is required' }).trim().min(1, 'name cannot be empty'),
  email: z
    .string({ required_error: 'email is required' })
    .trim()
    .email('Invalid email address')
    .toLowerCase(),
  company: z.string().trim().optional(),
});

export type CreateClientInput = z.infer<typeof createClientSchema>;

export class ClientsRepository {
  async createClient(data: CreateClientInput): Promise<IClient> {
    const validated = createClientSchema.parse(data);
    const client = new ClientModel(validated);
    return await client.save();
  }

  async listClients(): Promise<IClient[]> {
    return await ClientModel.find({}).sort({ createdAt: -1 });
  }

  async findClientById(id: string): Promise<IClient | null> {
    return await ClientModel.findById(id);
  }

  async findClientByEmail(email: string): Promise<IClient | null> {
    return await ClientModel.findOne({ email: email.toLowerCase().trim() });
  }
}

export const clientsRepository = new ClientsRepository();

