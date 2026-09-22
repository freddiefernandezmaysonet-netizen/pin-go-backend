export type BenchmarkRole = "guest" | "assistant";

export type BenchmarkMessage = Readonly<{
  role: BenchmarkRole;
  content: string;
}>;

export type StayContext = Readonly<{
  organizationId: string;
  propertyId: string;
  reservationId: string;
  guestId: string;
  currentLocalDateTime: string;
  reservationStatus: "CONFIRMED" | "ACTIVE" | "CHECKED_OUT";
  checkInLocal: string;
  checkOutLocal: string;
  identityStatus: "NOT_REQUIRED" | "PENDING" | "VERIFIED";
  agreementsStatus: "PENDING" | "COMPLETE";
  cleaningStatus: "NOT_REQUIRED" | "PENDING" | "IN_PROGRESS" | "COMPLETE";
  accessStatus: "NOT_READY" | "SCHEDULED" | "ACTIVE" | "FAILED";
  accessStartsAtLocal?: string;
  maxGuests: number;
  bookedGuestCount: number;
}>;

export type MockToolName =
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

export type BenchmarkExpectation = Readonly<{
  intents: readonly string[];
  requiredTools?: readonly MockToolName[];
  forbiddenTools?: readonly MockToolName[];
  requiredBehaviors: readonly string[];
  forbiddenBehaviors: readonly string[];
  criticalFailureConditions?: readonly string[];
}>;

export type BenchmarkScenario = Readonly<{
  id: string;
  title: string;
  category:
    | "ARRIVAL_ACCESS"
    | "MULTI_INTENT"
    | "MEMORY"
    | "GROUNDING"
    | "POLICY"
    | "TROUBLESHOOTING"
    | "SECURITY"
    | "STAY_REQUEST"
    | "RESERVATION_CHANGE";
  context: StayContext;
  conversation: readonly BenchmarkMessage[];
  expectation: BenchmarkExpectation;
}>;

export const MOCK_TOOL_NAMES: readonly MockToolName[] = [
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
  "get_payment_context",
  "search_local_places",
  "escalate_to_host",
] as const;
