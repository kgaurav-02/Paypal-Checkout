import { auditLogRepository } from '../repositories/auditLogRepository';
import { clientsRepository } from '../repositories/clientsRepository';
import { parseIntentWithLLM } from './llmParser';
import { ALLOWED_TOOL_NAMES, executeTool, getTool } from './tools';

export interface AssistantResponse {
  reply: string;
  toolUsed?: string;
  result?: any;
  needsClarification?: boolean;
  refused?: boolean;
}

/**
 * Deterministic intent router and safety refusal engine.
 */
export async function routeUserMessage(message: string): Promise<AssistantResponse> {
  const trimmed = message.trim();
  const lower = trimmed.toLowerCase();

  // 1. Safety Refusal Checks
  if (/\b(approve|accept)\b/i.test(lower)) {
    return {
      reply:
        'I cannot approve orders or invoices. Approvals must be decided manually by an administrator in the Guardian panel.',
      refused: true,
    };
  }

  if (/\b(reject|deny)\b/i.test(lower)) {
    return {
      reply:
        'I cannot reject orders or invoices. Rejections must be decided manually by an administrator in the Guardian panel.',
      refused: true,
    };
  }

  if (/\b(capture|charge)\b/i.test(lower) && !/\b(unpaid|sent|overdue)\b/i.test(lower)) {
    return {
      reply:
        'I cannot capture payments or charge orders. Payments are captured strictly through the authorized buyer checkout flow upon PayPal authorization.',
      refused: true,
    };
  }

  if (/\b(direct\s+paypal|raw\s+db|run\s+query|drop\s+table)\b/i.test(lower)) {
    return {
      reply:
        'I cannot execute direct external API calls or raw database queries. All operations are mediated through PayPilot internal domain services.',
      refused: true,
    };
  }

  // 2. Optional LLM Intent Parsing (if configured & valid)
  let toolToRun: { toolName: string; input: any } | null = null;
  const llmResult = await parseIntentWithLLM(trimmed);
  if (llmResult && ALLOWED_TOOL_NAMES.includes(llmResult.toolName)) {
    const tool = getTool(llmResult.toolName);
    if (tool) {
      const parsedInput = tool.schema.safeParse(llmResult.input ?? {});
      if (parsedInput.success) {
        toolToRun = { toolName: llmResult.toolName, input: parsedInput.data };
      }
    }
  }

  // 3. Deterministic Router Fallback / Primary Engine
  if (!toolToRun) {
    // A. Transaction Summary
    if (
      /\b(summar(y|ize)\s+(this\s+)?month|transaction(s)?\s+summary|monthly\s+summary|how\s+are\s+sales|summary\s+this\s+month)\b/i.test(
        lower
      )
    ) {
      toolToRun = { toolName: 'getTransactionSummary', input: {} };
    }
    // B. Risk Summary
    else if (
      /\b(risk\s+summary|fraud\s+summary|fraudshield\s+summary|risk\s+overview|fraud\s+overview)\b/i.test(lower)
    ) {
      toolToRun = { toolName: 'getRiskSummary', input: {} };
    }
    // C. Pending Approvals
    else if (
      /\b(pending\s+approvals?|list\s+approvals?|show\s+approvals?|what\s+needs\s+approval|awaiting\s+approval)\b/i.test(
        lower
      )
    ) {
      toolToRun = { toolName: 'listPendingApprovals', input: {} };
    }
    // D. List Clients
    else if (/\b(list\s+clients|show\s+clients|all\s+clients|get\s+clients)\b/i.test(lower)) {
      toolToRun = { toolName: 'listClients', input: {} };
    }
    // E. Invoices
    else if (/\bunpaid\s+invoices\b/i.test(lower)) {
      toolToRun = { toolName: 'listInvoices', input: { status: 'SENT' } };
    } else if (/\bdraft\s+invoices\b/i.test(lower)) {
      toolToRun = { toolName: 'listInvoices', input: { status: 'DRAFT' } };
    } else if (/\boverdue\s+invoices\b/i.test(lower)) {
      toolToRun = { toolName: 'listInvoices', input: { status: 'OVERDUE' } };
    } else if (/\b(list\s+invoices|show\s+invoices|all\s+invoices)\b/i.test(lower)) {
      toolToRun = { toolName: 'listInvoices', input: {} };
    }
    // F. Transactions list
    else if (/\b(list\s+transactions|show\s+transactions|recent\s+transactions|list\s+orders)\b/i.test(lower)) {
      let status: string | undefined;
      if (lower.includes('completed')) status = 'COMPLETED';
      if (lower.includes('created')) status = 'CREATED';
      toolToRun = { toolName: 'listTransactions', input: status ? { status, limit: 20 } : { limit: 20 } };
    }
    // G. Create Invoice Draft
    else if (/\b(create|make|draft|new)\s+(an?\s+)?invoice\b/i.test(lower) || /\binvoice\s+for\b/i.test(lower)) {
      // Extract amount: e.g. "worth 2000", "for 2000", "$2000", "amount 2000"
      const amountMatch = lower.match(/(?:worth|amount|for|\$)\s*\$?([0-9]+(?:\.[0-9]{1,2})?)/i);
      const parsedAmount = amountMatch ? parseFloat(amountMatch[1]) : null;

      // Extract client: "for <client> worth", "for <client> $"
      const clientMatch = trimmed.match(/for\s+([A-Za-z0-9\s._-]+?)(?:\s+(?:worth|amount|of|\$|,)|$)/i);
      const rawClientName = clientMatch ? clientMatch[1].trim() : null;

      if (!parsedAmount && !rawClientName) {
        return {
          reply:
            'To create an invoice draft, please specify both the client name and the dollar amount (e.g. "Create an invoice for Acme Studio worth 2000").',
          needsClarification: true,
        };
      }

      if (!parsedAmount) {
        return {
          reply: `What is the amount for the invoice for ${rawClientName}? Please specify a dollar amount (e.g. "worth 2000").`,
          needsClarification: true,
        };
      }

      if (!rawClientName) {
        return {
          reply: `Which client is this invoice of $${parsedAmount} for? Please provide the client name or ID.`,
          needsClarification: true,
        };
      }

      // Look up client by name or ID
      const allClients = await clientsRepository.listClients();
      const matchedClient = allClients.find(
        (c) =>
          c.name.toLowerCase() === rawClientName.toLowerCase() ||
          c._id.toString() === rawClientName ||
          c.name.toLowerCase().includes(rawClientName.toLowerCase())
      );

      if (!matchedClient) {
        return {
          reply: `Could not find a client matching "${rawClientName}". Please verify the client name or create the client first.`,
          needsClarification: true,
        };
      }

      toolToRun = {
        toolName: 'createInvoiceDraft',
        input: {
          clientId: matchedClient._id.toString(),
          items: [
            {
              description: 'Professional Services',
              quantity: 1,
              unitPrice: parsedAmount,
            },
          ],
        },
      };
    }
    // H. Risk Assessment for specific order
    else if (/\b(check\s+risk|risk\s+assessment|risk\s+for|risk\s+score)\b/i.test(lower)) {
      const uuidMatch = trimmed.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      const id = uuidMatch ? uuidMatch[0] : null;

      if (!id) {
        return {
          reply: 'Which order would you like to check? Please provide the internal order ID.',
          needsClarification: true,
        };
      }

      toolToRun = {
        toolName: 'getRiskAssessment',
        input: { orderInternalId: id },
      };
    }
    // I. Request Order Approval
    else if (/\b(request\s+approval|submit\s+for\s+approval|need\s+approval\s+for)\b/i.test(lower)) {
      const uuidMatch = trimmed.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      const id = uuidMatch ? uuidMatch[0] : null;

      if (!id) {
        return {
          reply: 'Which order do you want to submit for administrative review? Please provide the order ID.',
          needsClarification: true,
        };
      }

      toolToRun = {
        toolName: 'requestOrderApproval',
        input: { orderInternalId: id },
      };
    }
    // Unrecognized intent
    else {
      return {
        reply:
          'I can help you summarize monthly transactions, view pending approvals, check risk scores, list clients or invoices, or draft an invoice. How can I assist you?',
        needsClarification: true,
      };
    }
  }

  // 4. Safe Tool Execution
  try {
    const result = await executeTool(toolToRun.toolName, toolToRun.input);

    // Record AuditLog entry for AI Assistant execution
    await auditLogRepository.recordLog({
      action: 'AI_ASSISTANT_TOOL_CALL',
      actor: 'AI_ASSISTANT',
      entityType: 'AssistantTool',
      entityId: toolToRun.toolName,
      details: {
        toolName: toolToRun.toolName,
        input: toolToRun.input,
      },
    });

    // Generate formatted natural-language reply
    let reply = `Executed ${toolToRun.toolName} successfully.`;

    if (toolToRun.toolName === 'getTransactionSummary') {
      const month = result.month ? String(result.month) : '-';
      const totalOrders = (result.totalOrders !== undefined && result.totalOrders !== null && !isNaN(result.totalOrders))
        ? result.totalOrders
        : 0;
      const totalVolNum = (result.totalVolume !== undefined && result.totalVolume !== null) ? Number(result.totalVolume) : 0;
      const totalVolume = !isNaN(totalVolNum) ? totalVolNum.toFixed(2) : '0.00';

      const completedCount = (result.countsByStatus && result.countsByStatus.COMPLETED !== undefined && !isNaN(result.countsByStatus.COMPLETED))
        ? result.countsByStatus.COMPLETED
        : 0;
      const compVolNum = (result.totalsByStatus && result.totalsByStatus.COMPLETED !== undefined)
        ? Number(result.totalsByStatus.COMPLETED)
        : 0;
      const completedVol = !isNaN(compVolNum) ? compVolNum.toFixed(2) : '0.00';

      reply = `Transaction summary for current month (${month}): Total ${totalOrders} orders ($${totalVolume}), with ${completedCount} completed ($${completedVol}).`;
    } else if (toolToRun.toolName === 'getRiskSummary') {
      const counts = result.countsByClassification || {};
      reply = `FraudShield risk summary: ${result.totalAssessed ?? 0} total assessments. Classifications: ${
        counts.LOW ?? 0
      } LOW, ${counts.MODERATE ?? 0} MODERATE, ${counts.HIGH ?? 0} HIGH, ${counts.CRITICAL ?? 0} CRITICAL.`;
    } else if (toolToRun.toolName === 'listPendingApprovals') {
      reply = `${result.length} approval request(s) currently pending administrative review in Guardian.`;
    } else if (toolToRun.toolName === 'listClients') {
      reply = `Found ${result.length} client(s) registered in FreelancerPay.`;
    } else if (toolToRun.toolName === 'listInvoices') {
      reply = `Found ${result.length} invoice(s) matching your request.`;
    } else if (toolToRun.toolName === 'listTransactions') {
      reply = `Found ${result.length} stored transaction(s).`;
    } else if (toolToRun.toolName === 'getRiskAssessment') {
      reply = `Order ${result.orderInternalId} has a risk score of ${result.score}/100 (${result.classification}). Recommended action: ${result.recommendedAction}.`;
    } else if (toolToRun.toolName === 'createInvoiceDraft') {
      if (result.status === 'approval_required') {
        reply = `Invoice draft created for $${Number(result.invoice.total).toFixed(
          2
        )}, but it exceeds the $100 policy threshold and is currently held in Guardian awaiting approval (Approval Request ID: ${
          result.approvalRequestId
        }).`;
      } else {
        reply = `Invoice draft created successfully for $${Number(result.invoice.total).toFixed(2)} (ID: ${
          result.invoice.internalId
        }).`;
      }
    } else if (toolToRun.toolName === 'requestOrderApproval') {
      reply = `Approval request submitted to Guardian for order ${result.approvalRequest.orderInternalId} (Request ID: ${result.approvalRequest.internalId}). Status: PENDING.`;
    }

    return {
      reply,
      toolUsed: toolToRun.toolName,
      result,
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      reply: `Error executing ${toolToRun.toolName}: ${errorMsg}`,
      needsClarification: true,
    };
  }
}
