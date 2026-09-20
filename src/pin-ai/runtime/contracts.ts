export type PinAIRuntimeToolName =
  | "get_property_knowledge"
  | "get_reservation_context"
  | "get_access_status"
  | "get_cleaning_status"
  | "check_early_checkin"
  | "check_late_checkout"
  | "check_extension_availability"
  | "calculate_extension_price"
  | "check_date_change"
  | "get_cancellation_policy"
  | "get_payment_context"
  | "search_local_places"
  | "escalate_to_host";

export type PinAIToolAuthority =
  | "READ_STABLE"
  | "READ_DYNAMIC"
  | "CHECK_ELIGIBILITY"
  | "EXTERNAL_READ"
  | "ESCALATION";

export type PinAIRuntimeToolDefinition = Readonly<{
  name: PinAIRuntimeToolName;
  authority: PinAIToolAuthority;
  description: string;
  parameters?: Readonly<Record<string, unknown>>;
}>;

export type PinAIConversationMessage = Readonly<{
  role: "guest" | "assistant";
  content: string;
  createdAt?: string;
}>;

export type PinAIStayContext = Readonly<{
  organizationId: string;
  propertyId: string;
  reservationId: string;
  guestId: string;
  currentLocalDateTime: string;
  preferredLanguage?: "en" | "es";
}>;

export type PinAIRuntimeRequest = Readonly<{
  context: PinAIStayContext;
  conversation: readonly PinAIConversationMessage[];
}>;

export type PinAIToolCall = Readonly<{
  name: PinAIRuntimeToolName;
  arguments: Readonly<Record<string, unknown>>;
}>;

export type PinAIRuntimeResponse = Readonly<{
  responseText: string;
  toolCalls: readonly PinAIToolCall[];
  escalationCreated: boolean;
  requiresHumanReview: boolean;
}>;

export const PIN_AI_RUNTIME_ENABLED_TOOL_NAMES = [
  "get_property_knowledge",
  "get_reservation_context",
  "get_access_status",
  "get_cleaning_status",
  "check_early_checkin",
  "check_late_checkout",
  "check_extension_availability",
  "calculate_extension_price",
  "check_date_change",
  "get_cancellation_policy",
  "escalate_to_host",
] as const satisfies readonly PinAIRuntimeToolName[];

export function isPinAIRuntimeToolEnabled(
  name: PinAIRuntimeToolName,
): boolean {
  return (PIN_AI_RUNTIME_ENABLED_TOOL_NAMES as readonly PinAIRuntimeToolName[]).includes(name);
}

export const PIN_AI_RUNTIME_TOOLS: readonly PinAIRuntimeToolDefinition[] = [
  {
    name: "get_property_knowledge",
    authority: "READ_STABLE",
    description: "Read stable, guest-facing property facts.",
  },
  {
    name: "get_reservation_context",
    authority: "READ_DYNAMIC",
    description: "Read canonical reservation and stay context.",
  },
  {
    name: "get_access_status",
    authority: "READ_DYNAMIC",
    description: "Read canonical access state without disclosing credentials by default.",
  },
  {
    name: "get_cleaning_status",
    authority: "READ_DYNAMIC",
    description: "Read current cleaning/readiness state.",
  },
  {
    name: "check_early_checkin",
    authority: "CHECK_ELIGIBILITY",
    description:
      "Evaluate an early check-in request using current reservation, turnover, cleaning, and availability evidence. This is read-only and does not approve or modify the stay.",
    parameters: {
      type: "object",
      properties: {
        requestedLocalTime: {
          type: "string",
          description: "Requested local arrival time in HH:MM format when stated by the guest.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "check_late_checkout",
    authority: "CHECK_ELIGIBILITY",
    description:
      "Evaluate a late-checkout request using the next reservation and required cleaning window. This is read-only and does not approve or modify checkout.",
    parameters: {
      type: "object",
      properties: {
        requestedLocalTime: {
          type: "string",
          description: "Requested local checkout time in HH:MM format when stated by the guest.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "check_extension_availability",
    authority: "CHECK_ELIGIBILITY",
    description:
      "Check read-only calendar availability for extending the current stay. This does not change dates or collect payment.",
    parameters: {
      type: "object",
      properties: {
        additionalNights: {
          type: "integer",
          minimum: 1,
          maximum: 30,
          description: "Number of additional nights requested by the guest.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "calculate_extension_price",
    authority: "CHECK_ELIGIBILITY",
    description:
      "Calculate a read-only estimated price difference for an available stay extension. This does not approve the extension, change reservation dates, or charge the guest.",
    parameters: {
      type: "object",
      properties: {
        additionalNights: {
          type: "integer",
          minimum: 1,
          maximum: 30,
          description: "Number of additional nights requested by the guest.",
        },
      },
      required: ["additionalNights"],
      additionalProperties: false,
    },
  },
  {
    name: "check_date_change",
    authority: "CHECK_ELIGIBILITY",
    description:
      "Check read-only availability and estimated pricing for moving the entire stay to exact proposed dates. This does not approve the request, change reservation dates, issue a refund, or charge the guest.",
    parameters: {
      type: "object",
      properties: {
        proposedCheckInDate: {
          type: "string",
          description: "Proposed check-in date in YYYY-MM-DD format.",
        },
        proposedCheckOutDate: {
          type: "string",
          description: "Proposed check-out date in YYYY-MM-DD format.",
        },
      },
      required: ["proposedCheckInDate", "proposedCheckOutDate"],
      additionalProperties: false,
    },
  },
  {
    name: "get_cancellation_policy",
    authority: "READ_DYNAMIC",
    description:
      "Read the reservation-specific cancellation policy snapshot and calculate the current estimated consequences. This does not cancel the reservation, approve an exception, or execute a refund.",
  },
  {
    name: "get_payment_context",
    authority: "READ_DYNAMIC",
    description:
      "Read guest-safe persisted payment and refund context for the scoped reservation. This does not authorize or execute a charge, refund, transfer, compensation, or reservation change.",
  },
  {
    name: "search_local_places",
    authority: "EXTERNAL_READ",
    description: "Search current nearby places for concierge requests.",
  },
  {
    name: "escalate_to_host",
    authority: "ESCALATION",
    description: "Create a bounded host escalation when autonomous resolution is exhausted or unsafe.",
  },
] as const;
