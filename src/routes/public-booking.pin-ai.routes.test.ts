import assert from "node:assert/strict";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";
import { sealGuestHistory } from "../pin-ai/guest/guest-history.js";

import {
  PinAIActionProposalError,
} from "../pin-ai/actions/action-proposal.service.js";
import { createConversationMemory } from "../pin-ai/runtime/conversation-memory.js";
import type {
  GuestPinAIGatewayPrisma,
  GuestPinAIRuntimeRunner,
} from "../pin-ai/guest/guest-runtime-gateway.js";
import { buildPublicBookingPinAIRouter } from "./public-booking.pin-ai.routes.js";

const token = "12345678-1234-1234-1234-123456789abc";

test("managed activation blocks chat and old paid confirmations despite a legacy canary", async () => {
  const now = new Date("2026-10-27T12:00:00Z");
  let orgEnabled = true, propertyEnabled = false;
  const prisma = {
    reservation: { findFirst: async () => ({ id: "reservation-a", propertyId: "property-a", status: "ACTIVE",
      preferredLanguage: "es", checkIn: new Date("2026-10-26T19:00:00Z"), checkOut: new Date("2026-10-28T15:00:00Z"),
      property: { organizationId: "org-a", status: "ACTIVE", timezone: "America/Puerto_Rico" } }) },
    property: { findFirst: async () => ({ pinAITermsVersion: "pin-ai-connect-usd-1-reservation-v1", pinAIEnabled: propertyEnabled,
      organization: { stripeConnectAccountId: "acct_synthetic", pinAIEnabled: orgEnabled, pinAIRevision: 1 } }) },
  };
  const forbidden = async () => { assert.fail("Disabled property must not invoke AI or payment execution"); };
  const app = express(); app.use(express.json());
  app.use(buildPublicBookingPinAIRouter({ prisma: prisma as never, now: () => now,
    runtime: forbidden, actionBrokerFactory: forbidden, stayTimeActions: { confirm: forbidden } as never,
    env: { PIN_AI_CONNECT_DEBIT_ENABLED: "true", PIN_AI_CONNECT_DEBIT_ORGANIZATION_IDS: "org-a", PIN_AI_RESERVATION_FEE_RECORDING_ENABLED: "true", PIN_AI_PROPERTY_ACTIVATION_ENABLED: "true", PIN_AI_GUEST_GATEWAY_ENABLED: "true",
      PIN_AI_ACTION_BROKER_ENABLED: "true", PIN_AI_STAY_TIME_CHAT_ENABLED: "true",
      PIN_AI_ACTION_CANARY_RESERVATION_IDS: "reservation-a" } }));
  const server = await new Promise<Server>(resolve => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/manage/${token}/pin-ai`;
    for (const scope of [[true, false], [false, true], [false, false]]) {
      [orgEnabled, propertyEnabled] = scope;
      assert.equal((await (await fetch(`${base}/availability`)).json()).available, false);
      for (const [path, body] of [["messages", { message: "Salida tardía" }],
        ["action-proposals/proposal-12345678/confirm", { confirmationToken: "old-confirmation" }]] as const) {
        const response = await fetch(`${base}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        assert.ok([403, 503].includes(response.status));
      }
    }
    orgEnabled = true; propertyEnabled = true;
    assert.equal((await (await fetch(`${base}/availability`)).json()).available, true);
  } finally { await closeServer(server); }
});

test("commercial stay-time confirmation needs host settings, while ordinary dates remain in the pilot", async () => {
  const now = new Date("2026-10-27T12:00:00Z");
  let configured = true, stayTime = true, executions = 0;
  const rule = { enabled: true, limitLocalTime: "12:00", fee: { mode: "FREE", amountMinor: 0, currency: "USD" } };
  const prisma = {
    reservation: { findFirst: async () => ({ id: "reservation-a", propertyId: "property-a", status: "ACTIVE",
      checkIn: new Date("2026-10-26T19:00:00Z"), checkOut: new Date("2026-10-28T15:00:00Z"),
      property: { organizationId: "org-a", timezone: "America/Puerto_Rico", pinAITermsAcceptedAt: new Date(+now - 1000),
        pinAITermsAcceptedBy: "host", stayTimeSettings: configured ? { earlyCheckin: rule, lateCheckout: rule } : null } }) },
    property: { findFirst: async () => ({ pinAITermsVersion: "pin-ai-connect-usd-1-reservation-v1", pinAIEnabled: true,
      organization: { stripeConnectAccountId: "acct_synthetic", pinAIEnabled: true, pinAIRevision: 1 } }) },
    pinAIActionProposal: { findFirst: async () => ({ id: "proposal-12345678", termsSnapshot: { version: stayTime ? "stay_time_quote_v1" : "date_change_v1" } }) },
  };
  const app = express(); app.use(express.json());
  app.use(buildPublicBookingPinAIRouter({ prisma: prisma as never, now: () => now,
    runtime: async () => { throw new Error("Must not call model"); },
    actionBrokerFactory: async () => { throw new Error("Ordinary date broker must stay disabled"); },
    stayTimeActions: { confirm: async () => { executions++; return { outcome: "WAITING_FOR_PAYMENT", actionExecuted: false }; } } as never,
    env: { PIN_AI_ALL_ORGANIZATIONS_ENABLED: "true", PIN_AI_CONNECT_DEBIT_ENABLED: "true", PIN_AI_RESERVATION_FEE_RECORDING_ENABLED: "true",
      PIN_AI_PROPERTY_ACTIVATION_ENABLED: "true", PIN_AI_GUEST_GATEWAY_ENABLED: "true", PIN_AI_ACTION_BROKER_ENABLED: "true",
      PIN_AI_ACTION_PROPOSAL_TOOL_ENABLED: "true", PIN_AI_STAY_TIME_CHAT_ENABLED: "true" } }));
  const server = await new Promise<Server>(resolve => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/manage/${token}/pin-ai/action-proposals/proposal-12345678/confirm`;
    const confirm = () => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ confirmationToken: "private-confirmation" }) });
    assert.equal((await confirm()).status, 200);
    configured = false;
    assert.equal((await confirm()).status, 503);
    configured = true; stayTime = false;
    assert.equal((await confirm()).status, 503);
    assert.equal(executions, 1);
  } finally { await closeServer(server); }
});

test("server window gates availability, messages and old confirmations without invoking AI or payments", async () => {
  let now = new Date("2026-10-25T18:59:59.999Z");
  let reservation: any = { id: "reservation-a", propertyId: "property-a", status: "ACTIVE",
    checkIn: new Date("2026-10-26T19:00:00Z"), checkOut: new Date("2026-10-28T15:00:00Z"),
    property: { status: "ACTIVE", timezone: "America/Puerto_Rico", organizationId: "org-a" } };
  const prisma = { reservation: { findFirst: async (args: any) => {
    assert.equal(args.where.guestToken, token);
    assert.deepEqual(args.where.guestTokenExpiresAt, { gt: now });
    return reservation;
  } } };
  const forbidden = async () => { assert.fail("No model, broker or stay-time execution outside the window"); };
  const app = express();
  app.use(express.json());
  app.use(buildPublicBookingPinAIRouter({ prisma: prisma as never, now: () => now,
    runtime: forbidden, actionBrokerFactory: forbidden, stayTimeActions: { confirm: forbidden } as never,
    env: { PIN_AI_GUEST_GATEWAY_ENABLED: "true", PIN_AI_ACTION_BROKER_ENABLED: "true",
      PIN_AI_STAY_TIME_CHAT_ENABLED: "true", PIN_AI_ACTION_CANARY_RESERVATION_IDS: "reservation-a" } }));
  const server = await new Promise<Server>(resolve => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/manage/${token}/pin-ai`;
    const availability = async () => {
      const response = await fetch(`${base}/availability`);
      assert.equal(response.headers.get("cache-control"), "no-store");
      return response;
    };
    for (const instant of ["2026-10-25T18:59:59.999Z", "2026-10-29T15:00:00Z"]) {
      now = new Date(instant);
      assert.equal((await (await availability()).json()).available, false);
      for (const [path, body] of [["messages", { message: "Salida tardía" }],
        ["action-proposals/proposal-12345678/confirm", { confirmationToken: "old-confirmation" }]] as const) {
        const response = await fetch(`${base}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        assert.equal(response.status, 403);
        assert.equal((await response.json()).error, "PIN_AI_OUTSIDE_AVAILABILITY_WINDOW");
      }
    }
    for (const instant of ["2026-10-25T19:00:00Z", "2026-10-29T14:59:59.999Z"]) {
      now = new Date(instant);
      const data = await (await availability()).json();
      assert.equal(data.available, true);
      assert.equal(data.timezone, "America/Puerto_Rico");
      assert.equal(data.closesAt, "2026-10-29T15:00:00.000Z");
    }
    reservation = { ...reservation, checkOut: new Date("2026-10-28T16:00:00Z") };
    now = new Date("2026-10-29T15:30:00Z");
    assert.equal((await (await availability()).json()).available, true);
    reservation.status = "CANCELLED";
    assert.equal((await (await availability()).json()).available, false);
    reservation = null;
    assert.equal((await availability()).status, 404);
    assert.equal((await fetch(`${base.replace(token, "bad")}/availability`)).status, 400);
  } finally { await closeServer(server); }
});

for (const enabled of [false, true]) test(`stay-time confirmation dispatch is gated separately: ${enabled}`, async () => {
  let executions = 0;
  const response = await requestAction({ confirmationToken: "private-confirmation" }, {
    stayTime: true, stayTimeEnabled: enabled,
    broker: { confirmAndExecute: async () => { throw new Error("Must not use date-change broker"); } },
    stayTimeConfirm: async input => {
      executions++;
      assert.deepEqual(input, { guestToken: token, proposalId: "proposal-12345678", confirmationToken: "private-confirmation" });
      return { outcome: "WAITING_FOR_PAYMENT", proposalId: input.proposalId, actionExecuted: false };
    },
  });
  assert.equal(response.status, enabled ? 200 : 503);
  assert.equal(executions, enabled ? 1 : 0);
});

test("stay-time status and history find the canonical modification after payment", async () => {
  const now = new Date("2026-10-03T12:00:00Z");
  const proposalId = "proposal-12345678";
  const p = { id: proposalId, status: "CONFIRMED", termsSnapshot: { version: "stay_time_quote_v1" } };
  let modificationReads = 0;
  const prisma = {
    reservation: { findFirst: async () => ({ id: "reservation-a", propertyId: "property-a", property: { organizationId: "org-a" } }) },
    pinAIActionProposal: { findFirst: async (args: any) => {
      assert.equal(args.where.organizationId, "org-a"); assert.equal(args.where.propertyId, "property-a"); return p;
    } },
    pinAIGuestConversation: { findUnique: async () => ({ guestHistoryCiphertext: sealGuestHistory({ reservationId: "reservation-a", guestToken: token }, "messages", [
      { id: "message-a", role: "assistant", text: "Oferta", actionProposal: { proposalId, actionType: "RESERVATION_MODIFICATION",
        quote: { amountDifference: 11.2, amountDifferenceCents: 1120, currency: "USD", quoteExpiresAt: now,
          quoteExpiresAtLocal: now.toISOString(), propertyTimezone: "America/Puerto_Rico" } } },
    ]), guestActionReceiptsCiphertext: null }) },
    reservationModification: { findFirst: async (args: any) => {
      modificationReads++;
      assert.deepEqual(args.where, { reservationId: "reservation-a", clientRequestId: `stay-time:${proposalId}`, requestSource: "PIN_AI_GUEST_SERVICES" });
      return { id: "modification-a", status: "APPLIED", stripePaymentStatus: "paid", appliedAt: now, checkoutExpiresAt: null };
    } },
  };
  const app = express();
  app.use(buildPublicBookingPinAIRouter({ prisma: prisma as never, env: {}, now: () => now,
    actionBrokerFactory: async () => { throw new Error("No payment provider on reads"); } }));
  const server = await new Promise<Server>(resolve => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
  try {
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/manage/${token}/pin-ai`;
    const status = await (await fetch(`${base}/action-proposals/${proposalId}/status`)).json();
    assert.equal(status.status.modificationStatus, "APPLIED");
    const history = await (await fetch(`${base}/history`)).json();
    assert.equal(history.messages[0].actionResult.outcome, "EXECUTED");
    assert.equal(history.messages[0].actionResult.checkoutUrl, null);
    assert.equal(modificationReads, 2);
  } finally { await closeServer(server); }
});

for (const scenario of ["pending", "paid", "payable", "processing", "paid processing", "expired", "foreign proposal", "foreign ciphertext", "invalid token", "expired token", "corrupt", "database error", "no history"] as const) {
  test(`durable history GET: ${scenario}`, async () => {
    const now = new Date("2026-09-27T03:40:00Z");
    const scope = { reservationId: "reservation-a", guestToken: token };
    const expiry = new Date("2026-09-27T04:30:00Z");
    const quote = { quotedAt: now, quoteExpiresAt: expiry, quoteExpiresAtLocal: "2026-09-27T00:30:00-04:00", priceGuaranteedUntil: expiry,
      propertyTimezone: "America/Puerto_Rico", availabilityCheckedAt: now, availabilityHeld: false,
      currentTotalAmount: 3.35, proposedTotalAmount: 4.47, amountDifference: 1.12, amountDifferenceCents: 112, currency: "USD", financialAction: "ADDITIONAL_PAYMENT_REQUIRED" };
    const proposal = { proposalId: "proposal-12345678", actionType: "RESERVATION_MODIFICATION", requiresGuestConfirmation: true,
      confirmationToken: "private-confirmation", expiresAt: expiry, quote };
    const messages = [{ id: "guest-one", role: "guest", text: "Extender mi salida" },
      { id: "assistant-one", role: "assistant", text: "Propuesta preparada", actionProposal: proposal }];
    const ciphertext = sealGuestHistory(scenario === "foreign ciphertext" ? { ...scope, reservationId: "reservation-b" } : scope, "messages", messages);
    const reads: string[] = [];
    const prisma = {
      reservation: { findFirst: async (args: any) => {
        reads.push("reservation");
        assert.deepEqual(args.where, { guestToken: token, guestTokenExpiresAt: { gt: now }, property: { status: "ACTIVE" } });
        if (scenario === "expired token") return null;
        return { id: scope.reservationId, propertyId: "property-a", property: { organizationId: "org-a" } };
      } },
      pinAIGuestConversation: { findUnique: async (args: any) => {
        reads.push("history");
        assert.deepEqual(args.where, { reservationId: scope.reservationId });
        if (scenario === "database error") throw new Error("private database detail");
        if (scenario === "no history") return null;
        return { guestHistoryCiphertext: scenario === "corrupt" ? "corrupt" : ciphertext,
          guestActionReceiptsCiphertext: sealGuestHistory(scope, "receipts", [{ proposalId: proposal.proposalId, modificationId: "modification-a", checkoutUrl: "https://checkout.example.test/private" }]) };
      } },
      pinAIActionProposal: { findFirst: async (args: any) => {
        reads.push("proposal");
        assert.deepEqual(args.where, { id: proposal.proposalId, reservationId: scope.reservationId, propertyId: "property-a", organizationId: "org-a", actionType: "RESERVATION_MODIFICATION" });
        return scenario === "foreign proposal" ? null : { id: proposal.proposalId, status: scenario === "pending" ? "PENDING_CONFIRMATION" : "CONFIRMED" };
      } },
      reservationModification: { findFirst: async (args: any) => {
        reads.push("modification");
        assert.deepEqual(args.where, { reservationId: scope.reservationId, clientRequestId: `pin_ai_${proposal.proposalId}`, requestSource: "PIN_AI_GUEST_SERVICES" });
        return scenario === "pending" ? null : { id: "modification-a", status: scenario === "paid" ? "APPLIED" : scenario === "processing" ? "PAYMENT_PROCESSING" : scenario === "expired" ? "EXPIRED" : "AWAITING_PAYMENT",
          stripePaymentStatus: ["paid", "paid processing"].includes(scenario) ? "paid" : "unpaid", checkoutExpiresAt: expiry, appliedAt: scenario === "paid" ? now : null };
      } },
    };
    const app = express();
    app.use(buildPublicBookingPinAIRouter({ prisma: prisma as never, env: {}, now: () => now,
      runtime: async () => { throw new Error("Must never run model"); },
      actionBrokerFactory: async () => { throw new Error("Must never create broker"); } }));
    const server = await new Promise<Server>(resolve => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/manage/${scenario === "invalid token" ? "bad" : token}/pin-ai/history`, { headers: { Connection: "close" } });
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.status, scenario === "invalid token" ? 400 : scenario === "expired token" ? 404 : ["corrupt", "foreign ciphertext", "database error"].includes(scenario) ? 503 : 200);
      const data = await response.json() as any;
      assert.doesNotMatch(JSON.stringify(data), /private database detail|openaiSessionId|guestHistoryCiphertext|stripePaymentIntentId/);
      if (response.ok) {
        assert.equal(data.version, 1);
        assert.equal(data.messages.length, scenario === "no history" ? 0 : 2);
        if (data.messages.length) {
          assert.equal(data.messages[0].text, "Extender mi salida");
          const result = data.messages[1].actionResult;
          if (scenario === "pending") assert.equal(result, undefined);
          else {
            assert.equal(result.outcome, scenario === "paid" ? "EXECUTED" : ["payable", "processing", "paid processing"].includes(scenario) ? "WAITING_FOR_PAYMENT" : "REVIEW_REQUIRED");
            assert.equal(result.checkoutUrl, scenario === "payable" ? "https://checkout.example.test/private" : null);
            assert.equal(result.actionExecuted, scenario === "paid");
          }
        }
      }
      if (scenario === "invalid token") assert.deepEqual(reads, []);
      if (scenario === "expired token") assert.deepEqual(reads, ["reservation"]);
    } finally { await closeServer(server); }
  });
}

for (const scenario of ["applied", "awaiting", "processing", "expired", "missing modification", "invalid token", "invalid proposal", "expired token", "other reservation", "database error"] as const) {
  test(`read-only action receipt: ${scenario}`, async () => {
    const now = new Date("2026-09-27T02:40:00Z");
    const reads: string[] = [];
    const prisma = {
      reservation: { findFirst: async (args: any) => {
        reads.push("reservation");
        assert.equal(args.where.guestToken, token);
        assert.deepEqual(args.where.guestTokenExpiresAt, { gt: now });
        assert.deepEqual(args.where.property, { status: "ACTIVE" });
        if (scenario === "database error") throw new Error("private database detail");
        if (scenario === "expired token") return null;
        return { id: "reservation-a", propertyId: "property-a", property: { organizationId: "org-a" } };
      } },
      pinAIActionProposal: { findFirst: async (args: any) => {
        reads.push("proposal");
        assert.deepEqual(args.where, { id: "proposal-12345678", reservationId: "reservation-a", propertyId: "property-a", organizationId: "org-a", actionType: "RESERVATION_MODIFICATION" });
        if (scenario === "other reservation") return null;
        return { id: "proposal-12345678", status: "CONFIRMED" };
      } },
      reservationModification: { findFirst: async (args: any) => {
        reads.push("modification");
        assert.deepEqual(args.where, { reservationId: "reservation-a", clientRequestId: "pin_ai_proposal-12345678", requestSource: "PIN_AI_GUEST_SERVICES" });
        if (scenario === "missing modification") return null;
        return { id: "modification-12345678", status: scenario === "applied" ? "APPLIED" : scenario === "processing" ? "PAYMENT_PROCESSING" : scenario === "expired" ? "EXPIRED" : "AWAITING_PAYMENT",
          stripePaymentStatus: scenario === "applied" ? "paid" : "unpaid", checkoutExpiresAt: new Date("2026-09-27T03:34:00Z"), appliedAt: scenario === "applied" ? now : null };
      } },
    };
    const app = express();
    app.use(buildPublicBookingPinAIRouter({ prisma: prisma as never, env: {}, now: () => now,
      runtime: async () => { throw new Error("Runtime must never be called"); },
      actionBrokerFactory: async () => { throw new Error("Broker must never be created"); } }));
    const server = await new Promise<Server>(resolve => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/manage/${scenario === "invalid token" ? "bad" : token}/pin-ai/action-proposals/${scenario === "invalid proposal" ? "bad" : "proposal-12345678"}/status`, { headers: { Connection: "close" } });
      assert.equal(response.headers.get("cache-control"), "no-store");
      const invalid = scenario === "invalid token" || scenario === "invalid proposal";
      assert.equal(response.status, invalid ? 400 : ["expired token", "other reservation"].includes(scenario) ? 404 : scenario === "database error" ? 503 : 200);
      const data = await response.json() as any;
      assert.doesNotMatch(JSON.stringify(data), /private database detail|confirmationToken|guestToken|stripeCheckout|checkoutUrl/);
      if (response.ok) {
        assert.equal(data.status.proposalId, "proposal-12345678");
        assert.equal(data.status.checkedAt, now.toISOString());
        assert.equal(data.status.modificationStatus, scenario === "missing modification" ? null : scenario === "applied" ? "APPLIED" : scenario === "processing" ? "PAYMENT_PROCESSING" : scenario === "expired" ? "EXPIRED" : "AWAITING_PAYMENT");
      }
      assert.deepEqual(reads, invalid ? [] : ["expired token", "database error"].includes(scenario) ? ["reservation"] : scenario === "other reservation" ? ["reservation", "proposal"] : ["reservation", "proposal", "modification"]);
    } finally { await closeServer(server); }
  });
}

function createPropertyKnowledgeRecord(propertyId: string, organizationId: string) {
  return {
    id: propertyId,
    organizationId,
    name: "Pin&Go Demo Property",
    publicTitle: "Pin&Go Demo Property",
    publicDescription: null,
    publicDescriptionEs: null,
    maxGuests: 3,
    timezone: "America/Puerto_Rico",
    checkInTime: "16:00",
    checkOutTime: "11:00",
    guestAccessMode: "PASSCODE_ONLY",
    amenities: [],
    taxes: [],
    listingDetails: {
      version: 1,
      accommodationType: "ENTIRE_PLACE",
      bedroomCount: 2,
      fullBathroomCount: 1,
      halfBathroomCount: 0,
      minimumPrimaryBookingGuestAge: 21,
      childrenPolicy: "ALLOWED",
      infantsPolicy: "NOT_ALLOWED",
      adultsOnly: "UNKNOWN",
      petsPolicy: "UNKNOWN",
      smokingPolicy: "UNKNOWN",
      vapingPolicy: "UNKNOWN",
      eventsPolicy: "UNKNOWN",
      unregisteredVisitorsPolicy: "UNKNOWN",
      quietHoursEnabled: "UNKNOWN",
      quietHoursStart: null,
      quietHoursEnd: null,
      parkingAvailability: "UNKNOWN",
      parkingType: null,
      parkingFeeType: null,
      parkingVehicleCapacity: null,
      smokeDetector: "UNKNOWN",
      carbonMonoxideDetector: "UNKNOWN",
      exteriorSecurityCameras: "UNKNOWN",
      exteriorSecurityCamerasDisclosureEn: null,
      exteriorSecurityCamerasDisclosureEs: null,
      animalsOnProperty: "UNKNOWN",
      animalsOnPropertyDisclosureEn: null,
      animalsOnPropertyDisclosureEs: null,
      stepFreeEntrance: "UNKNOWN",
      entranceStepCount: null,
      elevatorAvailable: "UNKNOWN",
      accessibleParking: "UNKNOWN",
      stepFreeBedroomAccess: "UNKNOWN",
      stepFreeBathroomAccess: "UNKNOWN",
      stepFreeShower: "UNKNOWN",
      sleepingAreas: [],
      sharedSpaces: [],
      safetyConsiderations: [],
      additionalConsiderations: [],
    },
    locks: [],
    propertyDevices: [],
    guestAgreements: [],
    cancellationPolicies: [],
    knowledgeEntries: [],
    reservations: [{
      id: "reservation-a",
      status: "ACTIVE",
      checkIn: new Date("2026-09-20T20:00:00.000Z"),
      checkOut: new Date("2026-09-22T15:00:00.000Z"),
    }],
  };
}

function createPrisma() {
  let conversation: {
    reservationId: string;
    openaiSessionId: string | null;
    leaseToken: string | null;
    leaseExpiresAt: Date | null;
  } | null = null;
  return {
    propertyReview: {
      async aggregate() {
        return { _avg: { overallRating: null }, _count: { _all: 0 } };
      },
    },
    property: {
      async findFirst(args: { where: { id: string; organizationId: string } }) {
        return createPropertyKnowledgeRecord(args.where.id, args.where.organizationId);
      },
    },
    reservation: {
      async findFirst() {
        return {
          id: "reservation-a",
          status: "ACTIVE",
          checkIn: new Date("2026-09-20T20:00:00Z"),
          checkOut: new Date("2026-09-22T15:00:00Z"),
          propertyId: "property-a",
          preferredLanguage: "en",
          property: {
            organizationId: "org-a",
            city: "San Juan",
            region: "PR",
            country: "PR",
            timezone: "America/Puerto_Rico",
          },
        };
      },
    },
    pinAIGuestConversation: {
      async findUnique() {
        return conversation
          ? { openaiSessionId: conversation.openaiSessionId }
          : null;
      },
      async create(args: {
        data: {
          reservationId: string;
          leaseToken: string;
          leaseExpiresAt: Date;
        };
      }) {
        conversation = {
          reservationId: args.data.reservationId,
          openaiSessionId: null,
          leaseToken: args.data.leaseToken,
          leaseExpiresAt: args.data.leaseExpiresAt,
        };
        return conversation;
      },
      async updateMany(args: {
        where: { reservationId: string; leaseToken?: string };
        data: Partial<{
          openaiSessionId: string | null;
          leaseToken: string | null;
          leaseExpiresAt: Date | null;
        }>;
      }) {
        if (
          !conversation ||
          conversation.reservationId !== args.where.reservationId ||
          (args.where.leaseToken !== undefined &&
            conversation.leaseToken !== args.where.leaseToken)
        ) {
          return { count: 0 };
        }
        conversation = { ...conversation, ...args.data };
        return { count: 1 };
      },
    },
  } as unknown as GuestPinAIGatewayPrisma;
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections?.();
  });
}

async function request(
  body: unknown,
  enabled = true,
  runtimeOverride?: GuestPinAIRuntimeRunner,
) {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/public-booking",
    buildPublicBookingPinAIRouter({
      prisma: createPrisma(),
      env: {
        PIN_AI_GUEST_GATEWAY_ENABLED: enabled ? "true" : "false",
      },
      runtime:
        runtimeOverride ??
        (async (runtimeRequest) => ({
          mode: "SHADOW",
          request: runtimeRequest,
          memory: createConversationMemory(runtimeRequest),
          response: {
            responseText: "I can check that for you.",
            openaiSessionId: "session_route_test",
            toolCalls: [],
            escalationCreated: false,
            requiresHumanReview: false,
          },
          actionsExecuted: false,
        })),
      now: () => new Date("2026-09-21T16:00:00.000Z"),
    }),
  );

  const server = await new Promise<Server>((resolve) => {
    const listener = app.listen(0, "127.0.0.1", () => resolve(listener));
  });
  const address = server.address() as AddressInfo;
  try {
    return await fetch(
      `http://127.0.0.1:${address.port}/api/public-booking/manage/${token}/pin-ai/messages`,
      {
        method: "POST",
        headers: {
          Connection: "close",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
  } finally {
    await closeServer(server);
  }
}

async function requestAction(
  body: unknown,
  options: Readonly<{
    enabled?: boolean;
    stayTime?: boolean;
    stayTimeEnabled?: boolean;
    stayTimeConfirm?: (input: { guestToken: string; proposalId: string; confirmationToken: string }) => Promise<unknown>;
    canaryReservationIds?: string;
    broker?: Readonly<{
      confirmAndExecute(
        input: Readonly<{
          guestToken: unknown;
          proposalId: unknown;
          confirmationToken: unknown;
        }>,
      ): Promise<unknown>;
    }>;
  }> = {},
) {
  const app = express();
  app.use(express.json());
  app.use(
    "/api/public-booking",
    buildPublicBookingPinAIRouter({
      prisma: { ...createPrisma(), ...(options.stayTime ? { pinAIActionProposal: { findFirst: async () => ({
        id: "proposal-12345678", termsSnapshot: { version: "stay_time_quote_v1" },
      }) } } : {}) } as never,
      ...(options.stayTimeConfirm ? { stayTimeActions: { confirm: options.stayTimeConfirm as never } } : {}),
      env: {
        PIN_AI_STAY_TIME_CHAT_ENABLED: options.stayTimeEnabled ? "true" : "false",
        PIN_AI_GUEST_GATEWAY_ENABLED:
          "true",
        PIN_AI_ACTION_BROKER_ENABLED:
          options.enabled === false
            ? "false"
            : "true",
        PIN_AI_ACTION_PROPOSAL_TOOL_ENABLED:
          "true",
        PIN_AI_ACTION_CANARY_RESERVATION_IDS:
          options.canaryReservationIds ??
          "reservation-a",
      },
      runtime: async (runtimeRequest) => ({
        mode: "SHADOW",
        request: runtimeRequest,
        memory:
          createConversationMemory(
            runtimeRequest,
          ),
        response: {
          responseText:
            "I can check that for you.",
          openaiSessionId:
            "session_route_test",
          toolCalls: [],
          escalationCreated:
            false,
          requiresHumanReview:
            false,
        },
        actionsExecuted: false,
      }),
      actionBroker:
        options.broker as never,
      now: () =>
        new Date(
          "2026-09-21T16:00:00.000Z",
        ),
    }),
  );

  const server =
    await new Promise<Server>(
      (resolve) => {
        const listener =
          app.listen(
            0,
            "127.0.0.1",
            () =>
              resolve(listener),
          );
      },
    );
  const address =
    server.address() as AddressInfo;

  try {
    return await fetch(
      `http://127.0.0.1:${address.port}/api/public-booking/manage/${token}/pin-ai/action-proposals/proposal-12345678/confirm`,
      {
        method: "POST",
        headers: {
          Connection: "close",
          "Content-Type":
            "application/json",
        },
        body:
          JSON.stringify(body),
      },
    );
  } finally {
    await closeServer(server);
  }
}

for (const scenario of ["recover", "provider-error", "disabled", "already-unpaid"] as const) {
  test(`stay-time status recovers only an authorized missing payment status: ${scenario}`, async () => {
    const now = new Date("2026-10-05T02:00:00Z");
    let payment: string | null = scenario === "already-unpaid" ? "unpaid" : null;
    let recoveries = 0;
    const deadline = new Date(now.getTime() + 3600000);
    const prisma = {
      reservation: { findFirst: async () => ({ id: "reservation-a", propertyId: "property-a", property: { organizationId: "org-a" } }) },
      pinAIActionProposal: { findFirst: async () => ({ id: "proposal-12345678", status: "CONFIRMED", termsSnapshot: { version: "stay_time_quote_v1" } }) },
      reservationModification: { findFirst: async (args: any) => {
        assert.equal(args.where.clientRequestId, "stay-time:proposal-12345678");
        return { id: "modification-a", status: "AWAITING_PAYMENT", stripePaymentStatus: payment, checkoutExpiresAt: deadline, appliedAt: null };
      } },
    };
    const app = express();
    app.use(buildPublicBookingPinAIRouter({ prisma: prisma as never, now: () => now,
      env: { PIN_AI_ACTION_BROKER_ENABLED: "true", PIN_AI_ACTION_PROPOSAL_TOOL_ENABLED: "true",
        PIN_AI_STAY_TIME_CHAT_ENABLED: scenario === "disabled" ? "false" : "true",
        PIN_AI_ACTION_CANARY_RESERVATION_IDS: "reservation-a" },
      runtime: async () => { throw new Error("No model call allowed"); },
      recoverStayTimePaymentStatus: async input => {
        recoveries++; assert.deepEqual(input, { guestToken: token, modificationId: "modification-a" });
        if (scenario === "provider-error") throw new Error("private-provider-detail");
        payment = "unpaid";
      } }));
    const server = await new Promise<Server>(resolve => { const listener = app.listen(0, "127.0.0.1", () => resolve(listener)); });
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/manage/${token}/pin-ai/action-proposals/proposal-12345678/status`);
      assert.equal(response.status, scenario === "provider-error" ? 503 : 200);
      const result = await response.json() as any;
      assert.doesNotMatch(JSON.stringify(result), /private-provider-detail|checkoutUrl|stripeCheckoutSessionId/);
      assert.equal(recoveries, ["disabled", "already-unpaid"].includes(scenario) ? 0 : 1);
      if (response.ok) {
        assert.equal(result.status.paymentStatus, scenario === "disabled" ? null : "unpaid");
        assert.equal(result.status.modificationId, "modification-a");
        assert.equal(result.status.paymentExpiresAt, deadline.toISOString());
      }
    } finally { await closeServer(server); }
  });
}

test("returns a minimal no-store shadow response without internal tool data", async () => {
  const response = await request({ message: "What time is checkout?" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    ok: true,
    reply: "I can check that for you.",
    mode: "SHADOW",
    conversationPersisted: true,
    escalationCreated: false,
    requiresHumanReview: false,
    actionsExecuted: false,
    databaseWrites: true,
    operationalWrites: false,
    webSearch: { enabled: false, used: false },
  });
});

test("message route returns a no-store structured action proposal without exposing runtime tool internals", async () => {
  const expiresAt = new Date("2026-09-26T15:00:00.000Z");
  const runtime: GuestPinAIRuntimeRunner = async (runtimeRequest) => ({
    mode: "SHADOW",
    request: runtimeRequest,
    memory: createConversationMemory(runtimeRequest),
    response: {
      responseText:
        "Preparé una cotización válida hasta la hora indicada. La disponibilidad no está retenida; usa el control de confirmación para continuar.",
      openaiSessionId: "session_route_action",
      toolCalls: [{
        name: "prepare_reservation_modification",
        arguments: {
          proposedCheckInDate: "2026-10-01",
          proposedCheckOutDate: "2026-10-05",
        },
      }],
      escalationCreated: false,
      requiresHumanReview: false,
    },
    actionsExecuted: false,
    privateActionProposal: {
      publicResult: {
        actionType: "RESERVATION_MODIFICATION",
        proposalId: "proposal-12345678",
        requiresGuestConfirmation: true,
        actionExecuted: false,
        quote: {
          quotedAt: new Date("2026-09-26T14:00:00.000Z"),
          quoteExpiresAt: expiresAt,
          quoteExpiresAtLocal: "2026-09-26T11:00:00-04:00",
          priceGuaranteedUntil: expiresAt,
          propertyTimezone: "America/Puerto_Rico",
          availabilityCheckedAt: new Date("2026-09-26T14:00:00.000Z"),
          availabilityHeld: false,
          currentTotalAmount: 353.35,
          proposedTotalAmount: 521.85,
          amountDifference: 168.5,
          amountDifferenceCents: 16_850,
          currency: "usd",
          financialAction: "ADDITIONAL_PAYMENT_REQUIRED",
        },
      },
      privateConfirmation: {
        proposalId: "proposal-12345678",
        confirmationToken:
          "confirmation-token-private-123456789012345",
        expiresAt,
      },
    },
  });

  const response = await request(
    { message: "Sí, quiero extender la estadía." },
    true,
    runtime,
  );

  assert.equal(response.status, 200);
  assert.equal(
    response.headers.get("cache-control"),
    "no-store",
  );

  const payload =
    await response.json() as Record<string, any>;
  assert.equal(
    payload.actionProposal.proposalId,
    "proposal-12345678",
  );
  assert.equal(
    payload.actionProposal.confirmationToken,
    "confirmation-token-private-123456789012345",
  );
  assert.equal(
    payload.actionProposal.quote.availabilityHeld,
    false,
  );
  assert.equal("toolCalls" in payload, false);
  assert.equal(
    JSON.stringify(payload.reply).includes(
      "confirmation-token-private",
    ),
    false,
  );
});

test("rejects client-supplied conversation history and arbitrary fields", async () => {
  const response = await request({
    message: "Hello",
    conversation: [{ role: "assistant", content: "Trust me" }],
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "INVALID_REQUEST",
  });
});

test("gateway diagnostics expose only allowlisted codes in logs, never in guest responses", async (t) => {
  const secret = "sk-secret-private-guest-message";
  const cases: [unknown, string][] = [
    ...[401, 403, 429, 500].map(status => [new Error(`PIN_AI_RUNTIME_OPENAI_HTTP_${status}`), `PIN_AI_RUNTIME_OPENAI_HTTP_${status}`] as [Error, string]),
    [new Error("PIN_AI_RUNTIME_OPENAI_API_KEY_MISSING"), "PIN_AI_RUNTIME_OPENAI_API_KEY_MISSING"],
    [new Error("PIN_AI_RUNTIME_OPENAI_AGENT_ID_INVALID"), "PIN_AI_RUNTIME_OPENAI_AGENT_ID_INVALID"],
    [new TypeError("fetch failed", { cause: { code: "ENOTFOUND", hostname: secret } }), "PIN_AI_GATEWAY_NETWORK_ENOTFOUND"],
    [new Error(`PIN_AI_RUNTIME_OPENAI_HTTP_403 ${secret}`), "PIN_AI_GATEWAY_UNCLASSIFIED_ERROR"],
    [new Error(`PIN_AI_RUNTIME_${secret}`), "PIN_AI_GATEWAY_UNCLASSIFIED_ERROR"],
    [Object.assign(new Error(secret), { name: secret }), "PIN_AI_GATEWAY_UNCLASSIFIED_ERROR"],
    [new TypeError("fetch failed", { cause: { code: secret } }), "PIN_AI_GATEWAY_UNCLASSIFIED_ERROR"],
    [secret, "PIN_AI_GATEWAY_UNKNOWN_ERROR"],
  ];
  for (const [error, expected] of cases) {
    const entries: unknown[][] = [];
    const logger = t.mock.method(console, "error", (...args: unknown[]) => { entries.push(args); });
    try {
      const response = await request({ message: "Hello" }, true, async () => { throw error; });
      assert.equal(response.status, 502);
      assert.deepEqual(await response.json(), { ok: false, error: "PIN_AI_UNAVAILABLE" });
      assert.deepEqual(entries, [["[public-booking pin-ai gateway]", { code: expected }]]);
      assert.equal(JSON.stringify(entries).includes(secret), false);
    } finally { logger.mock.restore(); }
  }
});

test("returns a controlled 503 while the guest gateway flag is disabled", async () => {
  const response = await request({ message: "Hello" }, false);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    ok: false,
    error: "PIN_AI_UNAVAILABLE",
  });
});


test(
  "keeps guest actions disabled behind an independent default-off flag",
  async () => {
    let calls = 0;
    const response =
      await requestAction(
        {
          confirmationToken:
            "confirmation-token-private-123456789012345",
        },
        {
          enabled: false,
          broker: {
            async confirmAndExecute() {
              calls += 1;
              return {};
            },
          },
        },
      );

    assert.equal(
      response.status,
      503,
    );
    assert.equal(calls, 0);
    assert.equal(
      response.headers.get(
        "cache-control",
      ),
      "no-store",
    );
    assert.deepEqual(
      await response.json(),
      {
        ok: false,
        error:
          "PIN_AI_ACTIONS_UNAVAILABLE",
      },
    );
  },
);

test(
  "keeps action confirmation disabled when the canary allowlist is empty",
  async () => {
    let calls = 0;
    const response =
      await requestAction(
        {
          confirmationToken:
            "confirmation-token-private-123456789012345",
        },
        {
          canaryReservationIds:
            "",
          broker: {
            async confirmAndExecute() {
              calls += 1;
              return {};
            },
          },
        },
      );

    assert.equal(
      response.status,
      503,
    );
    assert.equal(calls, 0);
    assert.deepEqual(
      await response.json(),
      {
        ok: false,
        error:
          "PIN_AI_ACTIONS_UNAVAILABLE",
      },
    );
  },
);

test(
  "keeps action confirmation disabled for a reservation outside the canary allowlist",
  async () => {
    let calls = 0;
    const response =
      await requestAction(
        {
          confirmationToken:
            "confirmation-token-private-123456789012345",
        },
        {
          canaryReservationIds:
            "reservation-other-12345678",
          broker: {
            async confirmAndExecute() {
              calls += 1;
              return {};
            },
          },
        },
      );

    assert.equal(
      response.status,
      503,
    );
    assert.equal(calls, 0);
    assert.deepEqual(
      await response.json(),
      {
        ok: false,
        error:
          "PIN_AI_ACTIONS_UNAVAILABLE",
      },
    );
  },
);

test(
  "confirms through the broker with only server-route credentials and returns structured action state",
  async () => {
    let received:
      Record<string, unknown> | null =
      null;

    const response =
      await requestAction(
        {
          confirmationToken:
            "confirmation-token-private-123456789012345",
        },
        {
          broker: {
            async confirmAndExecute(
              input,
            ) {
              received = {
                ...input,
              };

              return {
                ok: true,
                actionType:
                  "RESERVATION_MODIFICATION",
                proposalId:
                  "proposal-12345678",
                outcome:
                  "WAITING_FOR_PAYMENT",
                actionExecuted:
                  false,
                quoteExpiresAt:
                  new Date(
                    "2026-09-26T15:00:00.000Z",
                  ),
                quoteExpiresAtLocal:
                  "2026-09-26T11:00:00-04:00",
                propertyTimezone:
                  "America/Puerto_Rico",
                availabilityHeld:
                  false,
                modificationId:
                  "modification-12345678",
                modificationStatus:
                  "AWAITING_PAYMENT",
                checkoutUrl:
                  "https://checkout.stripe.test/session",
                paymentExpiresAt:
                  new Date(
                    "2026-09-26T15:20:00.000Z",
                  ),
                amountDifference:
                  168.5,
                amountDifferenceCents:
                  16_850,
                currency: "usd",
                reasonCode: null,
              };
            },
          },
        },
      );

    assert.equal(
      response.status,
      200,
    );
    assert.deepEqual(
      received,
      {
        guestToken: token,
        proposalId:
          "proposal-12345678",
        confirmationToken:
          "confirmation-token-private-123456789012345",
      },
    );

    const payload =
      await response.json() as {
        action: {
          outcome: string;
          actionExecuted:
            boolean;
          checkoutUrl:
            string;
          availabilityHeld:
            boolean;
        };
      };

    assert.equal(
      payload.action.outcome,
      "WAITING_FOR_PAYMENT",
    );
    assert.equal(
      payload.action
        .actionExecuted,
      false,
    );
    assert.equal(
      payload.action
        .availabilityHeld,
      false,
    );
    assert.equal(
      payload.action.checkoutUrl,
      "https://checkout.stripe.test/session",
    );
  },
);

test(
  "rejects extra action-confirmation fields before the broker is called",
  async () => {
    let calls = 0;
    const response =
      await requestAction(
        {
          confirmationToken:
            "confirmation-token-private-123456789012345",
          execute: true,
        },
        {
          broker: {
            async confirmAndExecute() {
              calls += 1;
              return {};
            },
          },
        },
      );

    assert.equal(
      response.status,
      400,
    );
    assert.equal(calls, 0);
    assert.deepEqual(
      await response.json(),
      {
        ok: false,
        error:
          "INVALID_REQUEST",
      },
    );
  },
);

test(
  "maps a wrong confirmation token to a controlled 403 without exposing internals",
  async () => {
    const response =
      await requestAction(
        {
          confirmationToken:
            "wrong-confirmation-token-123456789012345",
        },
        {
          broker: {
            async confirmAndExecute() {
              throw new PinAIActionProposalError(
                "PROPOSAL_TOKEN_MISMATCH",
                403,
              );
            },
          },
        },
      );

    assert.equal(
      response.status,
      403,
    );
    assert.deepEqual(
      await response.json(),
      {
        ok: false,
        error:
          "INVALID_CONFIRMATION",
      },
    );
  },
);
