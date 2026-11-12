import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

export const envSchema = z.object({
  PAYPAL_CLIENT_ID: z
    .string({
      required_error: 'PAYPAL_CLIENT_ID is required',
      invalid_type_error: 'PAYPAL_CLIENT_ID must be a string',
    })
    .min(1, 'PAYPAL_CLIENT_ID cannot be empty')
    .default('BAA6p-STRM_0Nyp2NQlk3uD9PuoJ_pq--DjvqXnmj0iTugwnLwq3qlenbCIiURIF_XvjavO1ZqVF2SOSzU'),

  PAYPAL_CLIENT_SECRET: z
    .string({
      required_error: 'PAYPAL_CLIENT_SECRET is required',
      invalid_type_error: 'PAYPAL_CLIENT_SECRET must be a string',
    })
    .min(1, 'PAYPAL_CLIENT_SECRET cannot be empty')
    .default('ELnWHkUxrSqbdYbzelotJhHJrzs4qHy20QTasTxDDj0GVe9z6QltGYKK3wPQiq4S1vP8ck9issJR1FCC'),

  PAYPAL_ENV: z.literal('sandbox', {
    errorMap: () => ({
      message: 'PAYPAL_ENV must be "sandbox" only',
    }),
  }),

  MAX_AMOUNT: z.preprocess(
    (val) => (val === undefined || val === '' ? 100 : Number(val)),
    z
      .number({
        invalid_type_error: 'MAX_AMOUNT must be a valid number',
      })
      .positive('MAX_AMOUNT must be a positive number')
  ),

  PORT: z.preprocess(
    (val) => (val === undefined || val === '' ? 3000 : Number(val)),
    z
      .number({
        invalid_type_error: 'PORT must be a valid port number',
      })
      .int('PORT must be an integer')
      .positive('PORT must be a positive integer')
  ),

  MONGODB_URI: z
    .string({
      required_error: 'MONGODB_URI is required',
      invalid_type_error: 'MONGODB_URI must be a string',
    })
    .min(1, 'MONGODB_URI cannot be empty'),

  PAYPAL_WEBHOOK_ID: z.string().optional().default(''),

  GEMINI_API_KEY: z.string().optional().default(''),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(rawEnv: NodeJS.ProcessEnv = process.env): Env {
  const result = envSchema.safeParse(rawEnv);

  if (!result.success) {
    console.error('\nEnvironment validation failed:');
    for (const issue of result.error.issues) {
      const varName = issue.path.length > 0 ? issue.path.join('.') : 'ENVIRONMENT';
      console.error(`  - ${varName}: ${issue.message}`);
    }
    console.error('\nPlease verify your environment variables. Never commit real secrets.\n');
    process.exit(1);
  }

  return result.data;
}

export const env: Env = validateEnv();
