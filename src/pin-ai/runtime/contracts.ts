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
    description: "Check whether early check-in is eligible.",
  },
  {
    name: "check_late_checkout",
    authority: "CHECK_ELIGIBILITY",
    description: "Check whether late checkout is eligible.",
  },
  {
    name: "check_extension_availability",
    authority: "CHECK_ELIGIBILITY",
    description: "Check whether a stay extension is available.",
  },
  {
    name: "calculate_extension_price",
    authority: "CHECK_ELIGIBILITY",
    description: "Calculate an extension price without charging.",
  },
  {
    name: "check_date_change",
    authority: "CHECK_ELIGIBILITY",
    description: "Check date-change options without committing them.",
  },
  {
    name: "get_cancellation_policy",
    authority: "READ_DYNAMIC",
    description: "Read the reservation-applicable cancellation policy.",
  },
  {
    name: "get_payment_context",
    authority: "READ_DYNAMIC",
    description: "Read payment context without executing financial actions.",
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
