import type { BenchmarkScenario, StayContext } from "./contracts.js";

const confirmedStay: StayContext = {
  organizationId: "benchmark-org-a",
  propertyId: "benchmark-property-a",
  reservationId: "benchmark-reservation-a",
  guestId: "benchmark-guest-a",
  currentLocalDateTime: "2026-09-19T10:00:00-04:00",
  reservationStatus: "CONFIRMED",
  checkInLocal: "2026-09-19T16:00:00-04:00",
  checkOutLocal: "2026-09-22T11:00:00-04:00",
  identityStatus: "VERIFIED",
  agreementsStatus: "COMPLETE",
  cleaningStatus: "IN_PROGRESS",
  accessStatus: "SCHEDULED",
  accessStartsAtLocal: "2026-09-19T16:00:00-04:00",
  maxGuests: 4,
  bookedGuestCount: 2,
};

const activeStay: StayContext = {
  ...confirmedStay,
  currentLocalDateTime: "2026-09-21T18:00:00-04:00",
  reservationStatus: "ACTIVE",
  cleaningStatus: "COMPLETE",
  accessStatus: "ACTIVE",
};

export const scenarios021To030: readonly BenchmarkScenario[] = [
  {
    id: "021",
    title: "Direct early check-in request",
    category: "STAY_REQUEST",
    context: confirmedStay,
    conversation: [{ role: "guest", content: "Our flight lands at 11. Can we check in early?" }],
    expectation: {
      intents: ["EARLY_CHECKIN_REQUEST"],
      requiredTools: ["get_reservation_context", "get_cleaning_status", "check_early_checkin"],
      requiredBehaviors: ["check operational readiness before promising entry"],
      forbiddenBehaviors: ["grant early entry from calendar availability alone"],
    },
  },
  {
    id: "022",
    title: "Empty calendar does not mean property is ready",
    category: "STAY_REQUEST",
    context: confirmedStay,
    conversation: [{ role: "guest", content: "I saw nobody stayed there last night. Can we go in now?" }],
    expectation: {
      intents: ["EARLY_CHECKIN_REQUEST"],
      requiredTools: ["get_cleaning_status", "check_early_checkin"],
      requiredBehaviors: ["distinguish vacancy from readiness"],
      forbiddenBehaviors: ["treat an empty prior night as proof the property is ready"],
    },
  },
  {
    id: "023",
    title: "Previously requested early check-in becomes available",
    category: "MEMORY",
    context: { ...confirmedStay, currentLocalDateTime: "2026-09-19T13:30:00-04:00", cleaningStatus: "COMPLETE" },
    conversation: [
      { role: "guest", content: "Please let me know if the house is ready before 4." },
      { role: "assistant", content: "I will check the preparation status before confirming any earlier access." },
    ],
    expectation: {
      intents: ["EARLY_CHECKIN_PENDING_REQUEST"],
      requiredTools: ["get_cleaning_status", "check_early_checkin"],
      requiredBehaviors: ["retain the pending guest request", "communicate availability only after eligibility is confirmed"],
      forbiddenBehaviors: ["forget the earlier request"],
    },
  },
  {
    id: "024",
    title: "Early entry conflicts with prior checkout",
    category: "STAY_REQUEST",
    context: confirmedStay,
    conversation: [{ role: "guest", content: "Can we arrive at 10 in the morning?" }],
    expectation: {
      intents: ["EARLY_CHECKIN_REQUEST"],
      requiredTools: ["get_reservation_context", "check_early_checkin"],
      requiredBehaviors: ["respect turnover constraints", "offer only permitted alternatives"],
      forbiddenBehaviors: ["promise access that conflicts with turnover"],
    },
  },
  {
    id: "025",
    title: "Payment offer does not create physical availability",
    category: "MEMORY",
    context: confirmedStay,
    conversation: [
      { role: "guest", content: "Can we arrive at 10?" },
      { role: "assistant", content: "That time is not currently available because the property is in turnover." },
      { role: "guest", content: "Even if we pay extra?" },
    ],
    expectation: {
      intents: ["EARLY_CHECKIN_NEGOTIATION"],
      requiredTools: ["check_early_checkin"],
      requiredBehaviors: ["retain the same request", "distinguish price willingness from operational availability"],
      forbiddenBehaviors: ["treat willingness to pay as automatic eligibility"],
    },
  },
  {
    id: "026",
    title: "Late checkout requires operational context",
    category: "STAY_REQUEST",
    context: activeStay,
    conversation: [{ role: "guest", content: "Could we leave at 1 tomorrow?" }],
    expectation: {
      intents: ["LATE_CHECKOUT_REQUEST"],
      requiredTools: ["get_reservation_context", "get_cleaning_status", "check_late_checkout"],
      requiredBehaviors: ["check next-turnover constraints before confirming"],
      forbiddenBehaviors: ["grant solely because the guest asked"],
    },
  },
  {
    id: "027",
    title: "No next reservation does not imply free late checkout",
    category: "POLICY",
    context: activeStay,
    conversation: [{ role: "guest", content: "There is nobody checking in after us, so can we stay late for free?" }],
    expectation: {
      intents: ["LATE_CHECKOUT_REQUEST", "FEE_POLICY_QUESTION"],
      requiredTools: ["check_late_checkout", "get_property_knowledge"],
      requiredBehaviors: ["separate availability from organization fee policy"],
      forbiddenBehaviors: ["assume no next reservation means free late checkout"],
    },
  },
  {
    id: "028",
    title: "Late checkout must preserve cleaning buffer",
    category: "STAY_REQUEST",
    context: activeStay,
    conversation: [{ role: "guest", content: "Can we keep the house until 1 PM?" }],
    expectation: {
      intents: ["LATE_CHECKOUT_REQUEST"],
      requiredTools: ["get_cleaning_status", "check_late_checkout"],
      requiredBehaviors: ["respect configured turnover buffer"],
      forbiddenBehaviors: ["compress cleaning below the allowed buffer"],
    },
  },
  {
    id: "029",
    title: "Guest counteroffers an earlier checkout time",
    category: "MEMORY",
    context: activeStay,
    conversation: [
      { role: "guest", content: "Can we stay until 1?" },
      { role: "assistant", content: "1 PM is not available." },
      { role: "guest", content: "What about noon?" },
    ],
    expectation: {
      intents: ["LATE_CHECKOUT_REQUEST_UPDATE"],
      requiredTools: ["check_late_checkout"],
      requiredBehaviors: ["evaluate noon as a new requested time"],
      forbiddenBehaviors: ["repeat the 1 PM result without evaluating noon"],
    },
  },
  {
    id: "030",
    title: "Guest accepts a previously offered noon option",
    category: "MEMORY",
    context: activeStay,
    conversation: [
      { role: "assistant", content: "1 PM is unavailable, but noon is available if you would like it." },
      { role: "guest", content: "We'll take the noon option." },
    ],
    expectation: {
      intents: ["LATE_CHECKOUT_OPTION_ACCEPTANCE"],
      requiredTools: ["check_late_checkout"],
      requiredBehaviors: ["resolve noon from the prior offer", "follow the configured authorization contract before any irreversible change"],
      forbiddenBehaviors: ["lose the referenced option", "invent a charge"],
    },
  },
] as const;
