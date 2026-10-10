import type { PrismaClient } from "@prisma/client";
import type { PinAIRuntimeToolExecutor } from "./tool-executor.js";
import type { PinAIRuntimeRequest, PinAIRuntimeToolName } from "./contracts.js";
import type { PinAIConversationMemory } from "./conversation-memory.js";
import { handleGuestIncident } from "../guest/guest-incident.service.js";
import { formatGuestIncidentReceipt, type GuestIncidentReceipt, type IncidentEnvironment } from "../guest/guest-incident-policy.js";

export type GuestIncidentRuntimeEvidence = Readonly<{
  receipt: GuestIncidentReceipt | null; operationalWrites: boolean; responseText: string;
}>;
export class GuestIncidentToolExecutor implements PinAIRuntimeToolExecutor {
  private evidence: GuestIncidentRuntimeEvidence | undefined;
  private rejectedQuoteResult: Readonly<Record<string, unknown>> | undefined;
  constructor(private readonly input: {
    prisma: PrismaClient; guestToken?: string;
    channel?: { bookingId: string; threadId: string; messageId: string };
    env: IncidentEnvironment; delegate: PinAIRuntimeToolExecutor;
  }) {}
  getEvidence() { return this.evidence; }
  async execute(tool: PinAIRuntimeToolName, args: Readonly<Record<string, unknown>>,
    request: PinAIRuntimeRequest, memory: PinAIConversationMemory): Promise<Readonly<Record<string, unknown>>> {
    if (tool !== "escalate_to_host") return this.input.delegate.execute(tool, args, request, memory);
    if (this.rejectedQuoteResult) return this.rejectedQuoteResult;
    if (this.evidence) throw new Error("PIN_AI_INCIDENT_ONE_OPERATION_PER_TURN");
    // Language is presentation metadata, never part of the incident command or authorization.
    const { responseLanguage, ...incidentArgs } = args;
    if (responseLanguage !== undefined && responseLanguage !== "es" && responseLanguage !== "en") {
      throw new Error("PIN_AI_INCIDENT_RESPONSE_LANGUAGE_INVALID");
    }
    const language = responseLanguage ?? (request.context.preferredLanguage === "es" ? "es" : "en");
    let receipt: GuestIncidentReceipt | null;
    try {
      receipt = await handleGuestIncident({ ...this.input, request, args: incidentArgs });
    } catch (error) {
      if (!(error instanceof Error) || error.message !== "PIN_AI_INCIDENT_UNSUPPORTED_GUEST_QUOTE") throw error;
      // The transaction rejected the quotes before any incident write. Finish
      // the tool protocol instead of leaving the provider waiting indefinitely.
      const responseText = language === "es"
        ? "No pude registrar el reporte ni solicitar asistencia. Para continuar, confirma brevemente qué problema sigue ocurriendo."
        : "I could not register the report or request assistance. To continue, briefly confirm which problem is still happening.";
      this.evidence = { receipt: null, operationalWrites: false, responseText };
      this.rejectedQuoteResult = {
        executed: false, incidentRecorded: false, receipt: null,
        reason: "PIN_AI_INCIDENT_UNSUPPORTED_GUEST_QUOTE",
        incidentResponseText: responseText,
        guestFacingConstraint: "No incident or notification was created. Do not retry escalation in this turn; wait for the guest to clarify. Respond naturally to the guest without claiming operational results or repeating incidentResponseText: the server appends that authoritative receipt separately.",
      };
      return this.rejectedQuoteResult;
    }
    const responseText = formatGuestIncidentReceipt(receipt, language,
      args.operation === "STATUS" ? "STATUS" : "REPORT");
    this.evidence = { receipt, responseText, operationalWrites: args.operation === "REPORT" };
    return { executed: this.evidence.operationalWrites, incidentRecorded: !!receipt, receipt,
      incidentResponseText: responseText, guestFacingConstraint: "Respond naturally to the guest's current message: acknowledge guest-supplied updates, explain relevant next steps or ask a useful question. Do not restate operational status, copy incidentResponseText or include its reference: the server appends that authoritative receipt separately. Registration, provider acceptance, delivery, host acknowledgement and resolution are separate facts. No repair or approval was performed." };
  }
}
