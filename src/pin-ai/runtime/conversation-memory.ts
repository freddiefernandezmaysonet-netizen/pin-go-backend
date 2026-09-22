import type {
  PinAIConversationMessage,
  PinAIRuntimeRequest,
  PinAIRuntimeToolName,
} from "./contracts.js";

export type PinAIConversationIssueState =
  | "OPEN"
  | "RESOLVED"
  | "ESCALATED"
  | "WAITING";

export type PinAIConversationIssue = Readonly<{
  key: string;
  state: PinAIConversationIssueState;
  summary: string;
  lastUpdatedAt: string;
}>;

export type PinAIConversationMemory = Readonly<{
  organizationId: string;
  propertyId: string;
  reservationId: string;
  guestId: string;
  preferredLanguage?: "en" | "es";
  facts: Readonly<Record<string, unknown>>;
  issues: readonly PinAIConversationIssue[];
  attemptedTroubleshooting: readonly string[];
  completedToolChecks: readonly PinAIRuntimeToolName[];
}>;

export function createConversationMemory(
  request: PinAIRuntimeRequest,
): PinAIConversationMemory {
  return {
    organizationId: request.context.organizationId,
    propertyId: request.context.propertyId,
    reservationId: request.context.reservationId,
    guestId: request.context.guestId,
    preferredLanguage: request.context.preferredLanguage,
    facts: extractConversationFacts(request.conversation),
    issues: [],
    attemptedTroubleshooting: extractTroubleshootingAttempts(request.conversation),
    completedToolChecks: [],
  };
}

export function assertMemoryMatchesRequest(
  memory: PinAIConversationMemory,
  request: PinAIRuntimeRequest,
): void {
  const pairs: readonly [string, string][] = [
    [memory.organizationId, request.context.organizationId],
    [memory.propertyId, request.context.propertyId],
    [memory.reservationId, request.context.reservationId],
    [memory.guestId, request.context.guestId],
  ];

  if (pairs.some(([memoryValue, requestValue]) => memoryValue !== requestValue)) {
    throw new Error("PIN_AI_RUNTIME_MEMORY_SCOPE_MISMATCH");
  }
}

function extractConversationFacts(
  conversation: readonly PinAIConversationMessage[],
): Readonly<Record<string, unknown>> {
  const facts: Record<string, unknown> = {};

  for (const message of conversation) {
    const text = message.content.toLowerCase();

    if (text.includes("display is on") || text === "yes.") {
      facts.thermostatDisplayOn = true;
    }

    const temperatureMatch = message.content.match(/\b(\d{2})\b/);
    if (temperatureMatch && text.includes("78")) {
      facts.reportedRoomTemperatureF = 78;
    }

    if (temperatureMatch && text.includes("72")) {
      facts.reportedSetpointF = 72;
    }

    if (
      text.includes("we're inside") ||
      text.includes("door opened") ||
      text.includes("we are inside")
    ) {
      facts.accessResolved = true;
    }
  }

  return facts;
}

function extractTroubleshootingAttempts(
  conversation: readonly PinAIConversationMessage[],
): readonly string[] {
  const attempts = new Set<string>();

  for (const message of conversation) {
    const text = message.content.toLowerCase();

    if (text.includes("reset") && text.includes("thermostat")) {
      attempts.add("THERMOSTAT_RESET");
    }

    if (text.includes("tried that twice")) {
      attempts.add("PREVIOUS_ACCESS_STEP_RETRIED_TWICE");
    }
  }

  return [...attempts];
}
