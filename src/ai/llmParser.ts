import { z } from 'zod';
import { env } from '../config/env';
import { ALLOWED_TOOL_NAMES, getTool } from './tools';

export const llmOutputSchema = z.object({
  toolName: z.string(),
  input: z.record(z.any()).default({}),
});

export type LLMOutput = z.infer<typeof llmOutputSchema>;

/**
 * Metadata for allowed tools exposed to the LLM.
 * Strictly excludes any client secrets, user data, or unapproved operations.
 */
export const TOOL_DESCRIPTIONS = [
  {
    name: 'getTransactionSummary',
    description: 'Get monthly transaction count and volume summary aggregated from stored orders.',
  },
  {
    name: 'listTransactions',
    description: 'List stored order transactions with optional status (e.g. COMPLETED, CREATED) and limit.',
  },
  {
    name: 'listPendingApprovals',
    description: 'List pending Guardian approval requests awaiting administrative decision.',
  },
  {
    name: 'listClients',
    description: 'List stored FreelancerPay clients.',
  },
  {
    name: 'listInvoices',
    description: 'List stored FreelancerPay invoices, optionally filtered by status (DRAFT, SENT, PAID, OVERDUE, CANCELLED).',
  },
  {
    name: 'getRiskSummary',
    description: 'Get aggregate FraudShield risk assessment summary and top triggered rules.',
  },
  {
    name: 'getRiskAssessment',
    description: 'Get risk assessment for an order by orderInternalId.',
  },
  {
    name: 'createInvoiceDraft',
    description: 'Create a draft invoice with clientId, items array [{ description, quantity, unitPrice }], and optional dueDate.',
  },
  {
    name: 'requestOrderApproval',
    description: 'Create a PENDING approval request in Guardian for an order by orderInternalId.',
  },
];

/**
 * Calls Gemini LLM to parse intent if GEMINI_API_KEY is configured.
 * If API key is missing, network fails, or response is invalid/unknown, returns null
 * to safely fall back to the deterministic router.
 */
export async function parseIntentWithLLM(
  message: string,
  apiKey: string = env.GEMINI_API_KEY
): Promise<LLMOutput | null> {
  if (!apiKey || apiKey.trim() === '' || apiKey === 'your_gemini_api_key_here') {
    return null;
  }

  try {
    const prompt = `You are a secure backend tool intent router for PayPilot.
Given the user request, identify which tool to invoke and extract its required parameters.

Available tools:
${JSON.stringify(TOOL_DESCRIPTIONS, null, 2)}

Strict Rules:
- Return ONLY valid JSON with keys: "toolName" (one of the available tools) and "input" (object matching the tool parameters).
- Never invent tools. Never suggest approve, reject, or capture actions.
- If no tool matches, return JSON with {"toolName": "none", "input": {}}.

User Request: "${message.replace(/"/g, '\\"')}"`;

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' },
      }),
    });

    if (!response.ok) {
      return null;
    }

    const data: any = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      return null;
    }

    const parsedJson = JSON.parse(text);
    const validated = llmOutputSchema.safeParse(parsedJson);
    if (!validated.success) {
      return null;
    }

    // Validate that toolName is registered and input conforms to tool schema
    const tool = getTool(validated.data.toolName);
    if (!tool || !ALLOWED_TOOL_NAMES.includes(validated.data.toolName)) {
      return null;
    }

    const schemaCheck = tool.schema.safeParse(validated.data.input);
    if (!schemaCheck.success) {
      return null;
    }

    return validated.data;
  } catch {
    // On any parsing or network error, safely fall back
    return null;
  }
}

