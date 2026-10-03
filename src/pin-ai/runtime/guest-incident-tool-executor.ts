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
  constructor(private readonly input: {
    prisma: PrismaClient; guestToken?: string;
    channel?: { bookingId: string; threadId: string; messageId: string };
    env: IncidentEnvironment; delegate: PinAIRuntimeToolExecutor;
  }) {}
  getEvidence() { return this.evidence; }
  async execute(tool: PinAIRuntimeToolName, args: Readonly<Record<string, unknown>>,
    request: PinAIRuntimeRequest, memory: PinAIConversationMemory): Promise<Readonly<Record<string, unknown>>> {
    if (tool !== "escalate_to_host") return this.input.delegate.execute(tool, args, request, memory);
    if (this.evidence) throw new Error("PIN_AI_INCIDENT_ONE_OPERATION_PER_TURN");
    const receipt = await handleGuestIncident({ ...this.input, request, args });
    const responseText = formatGuestIncidentReceipt(receipt, request.context.preferredLanguage === "es" ? "es" : "en");
    this.evidence = { receipt, responseText, operationalWrites: args.operation === "REPORT" };
    return { executed: this.evidence.operationalWrites, incidentRecorded: !!receipt, receipt,
      incidentResponseText: responseText, guestFacingConstraint: "Use the exact incidentResponseText. Registration, provider acceptance, delivery, host acknowledgement and resolution are separate facts. No repair or approval was performed." };
  }
}
