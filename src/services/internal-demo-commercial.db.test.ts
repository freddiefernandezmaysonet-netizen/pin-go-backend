import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import http from "node:http";
import https from "node:https";

const databaseUrl = process.env.DEMO_COMMERCIAL_TEST_DATABASE_URL;

test("one Demo reservation through HTTP, messages, access, incident, host and cleaning on disposable PostgreSQL", {
  skip: !databaseUrl, timeout: 120_000,
}, async t => {
  const url = new URL(databaseUrl!);
  assert.equal(process.env.NODE_ENV, "test");
  assert.equal(process.env.DATABASE_URL, databaseUrl);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.pathname, "/pingo_demo_commercial_test");
  assert.equal(url.search, "");
  Object.assign(process.env, {
    CI: "true", GUEST_SMS_ENABLED: "1", RESEND_API_KEY: "re_synthetic_never_sent", STRIPE_SECRET_KEY: "sk_test_synthetic_never_sent",
    APP_URL: "https://app.example.invalid", PUBLIC_API_BASE_URL: "https://api.example.invalid",
    TTLOCK_API_BASE: "https://ttlock.example.invalid", TTLOCK_CLIENT_ID: "synthetic",
    ACCESS_CODE_ENC_KEY_BASE64: Buffer.alloc(32, 7).toString("base64"),
  });
  const emails: any[] = [], hardware: { path: string; form: URLSearchParams }[] = [], sms: any[] = [];
  const noGateway = new Set<number>();
  const pinInventory = new Map<number, any[]>();
  let nextPinId = 910001;
  let customFailure: "offline" | "accepted-timeout" | null = null;
  let openaiFixture: ReturnType<typeof import("../pin-ai/runtime/runtime-turn.test-fixture.js").createTurnFixture> | undefined;
  let forbidden = 0;
  const original = { fetch: globalThis.fetch, request: http.request, get: http.get,
    httpsRequest: https.request, httpsGet: https.get };
  const deny = () => { forbidden++; throw new Error("EXTERNAL_NETWORK_FORBIDDEN"); };
  // Only the local HTTP application can use the network. Provider boundaries
  // below are controlled transports, NOT a live email/AI/hardware certificate.
  http.request = ((...args: any[]) => {
    const first = args[0];
    const hostname = typeof first === "string" || first instanceof URL ? new URL(first).hostname : first.hostname;
    if (!["127.0.0.1", "localhost"].includes(hostname)) return deny();
    return (original.request as any)(...args);
  }) as any;
  https.request = deny as any; https.get = deny as any;
  globalThis.fetch = async (input, init) => {
    const address = new URL(String(input));
    if (address.hostname === "127.0.0.1") return original.fetch(input, init);
    if (address.origin === "https://api.openai.com" && openaiFixture) {
      const response = await openaiFixture.fetchImpl(String(input), {
        method: init?.method === "POST" ? "POST" : "GET", headers: {},
        ...(typeof init?.body === "string" ? { body: init.body } : {}),
      });
      const payload = await response.json() as any;
      if (payload.id === openaiFixture.sessionId) payload.metadata = openaiFixture.createPayload.metadata;
      return new Response(JSON.stringify(payload), { status: response.status });
    }
    if (address.origin === "https://api.resend.com" && address.pathname === "/emails") {
      const payload = JSON.parse(String(init?.body));
      assert.ok([payload.to].flat().every((to: string) => to.endsWith("@example.invalid")));
      emails.push(payload);
      return new Response(JSON.stringify({ id: `synthetic-email-${emails.length}` }), { status: 200 });
    }
    if (address.origin === "https://ttlock.example.invalid") {
      const form = new URLSearchParams(String(init?.body));
      const hardwareLock = Number(form.get("lockId"));
      assert.ok([29944630, 990001, 990002].includes(hardwareLock));
      hardware.push({ path: address.pathname, form });
      if (address.pathname === "/v3/gateway/listByLock") {
        return Response.json({ list: noGateway.has(hardwareLock) ? [] : [{ gatewayId: 777 }] });
      }
      if (address.pathname === "/v3/lock/listKeyboardPwd") {
        const list = pinInventory.get(hardwareLock) ?? [];
        return Response.json({ list, total: list.length });
      }
      if (address.pathname === "/v3/lock/getKeyboardPwdVersion") return Response.json({ keyboardPwdVersion: 4 });
      if (address.pathname === "/v3/keyboardPwd/get") {
        assert.ok(noGateway.has(hardwareLock)); assert.equal(form.get("keyboardPwdType"), "3");
        return Response.json({ keyboardPwdId: nextPinId++, keyboardPwd: "87654321" });
      }
      if (address.pathname === "/v3/keyboardPwd/add") {
        if (customFailure === "offline") return Response.json({ errcode: -2012, errmsg: "not connected to gateway" });
        const list = pinInventory.get(hardwareLock) ?? [];
        assert.ok(!list.some(p => p.keyboardPwd === form.get("keyboardPwd")), "candidate must be free on this lock");
        const keyboardPwdId = nextPinId++;
        list.push({ keyboardPwdId, keyboardPwd: form.get("keyboardPwd"), keyboardPwdName: form.get("keyboardPwdName"),
          keyboardPwdType: Number(form.get("keyboardPwdType")), startDate: Number(form.get("startDate")),
          endDate: Number(form.get("endDate")), status: 1 });
        pinInventory.set(hardwareLock, list);
        if (customFailure === "accepted-timeout") throw new Error("synthetic response lost after hardware accepted");
        return Response.json({ keyboardPwdId });
      }
      if (["/v3/keyboardPwd/delete", "/v3/identityCard/changePeriod"].includes(address.pathname)) {
        if (address.pathname === "/v3/keyboardPwd/delete") {
          pinInventory.set(hardwareLock, (pinInventory.get(hardwareLock) ?? []).filter(p => p.keyboardPwdId !== Number(form.get("keyboardPwdId"))));
        }
        return new Response(JSON.stringify({ errcode: 0 }), { status: 200 });
      }
    }
    return deny();
  };
  t.after(() => {
    globalThis.fetch = original.fetch; http.request = original.request; http.get = original.get;
    https.request = original.httpsRequest; https.get = original.httpsGet;
    assert.equal(forbidden, 0, "no unapproved provider endpoint was called");
  });
  const { PrismaClient } = await import("@prisma/client");
  const db = new PrismaClient();
  t.after(() => db.$disconnect());
  assert.equal(await db.organization.count(), 0, "requires an empty disposable database");
  const org = await db.organization.create({ data: { name: "Synthetic Demo journey" } });
  const propertyId = "cmomyua8b0001rv1dvl6xjr6g";
  const property = await db.property.create({ data: { id: propertyId, organizationId: org.id,
    name: "Synthetic Demo", status: "ACTIVE", timezone: "America/Puerto_Rico", cleaningNfcEnabled: true,
    cleaningStartOffsetMinutes: 15, cleaningDurationMinutes: 240, guestAccessMode: "PASSCODE_PLUS_NFC",
    distributionEnabled: true, distributionStatus: "ACTIVE" } });
  await db.lock.create({ data: { propertyId, ttlockLockId: 29944630, isActive: true } });
  await db.tTLockAuth.create({ data: { organizationId: org.id, accessToken: "synthetic",
    refreshToken: "synthetic", expiresAt: new Date(Date.now() + 30 * 86400000) } });
  // Mirror the real Demo organization: its principal is the platform operator,
  // with no ORG_ADMIN. Another platform account must never receive the demo.
  const principal = await db.dashboardUser.create({ data: { organizationId: org.id,
    email: "principal@example.invalid", passwordHash: "not-a-login", fullName: "Synthetic principal", role: "PLATFORM_ADMIN" } });
  const platform = principal;
  await db.dashboardUser.create({ data: { organizationId: org.id,
    email: "other-platform@example.invalid", passwordHash: "not-a-login", role: "PLATFORM_ADMIN", createdAt: new Date(Date.now() - 1000) } });
  const orgAdmin = await db.dashboardUser.create({ data: { organizationId: org.id, isActive: false,
    email: "org-admin@example.invalid", passwordHash: "not-a-login", role: "ORG_ADMIN" } });
  const cleaner = await db.staffMember.create({ data: { organizationId: org.id,
    fullName: "Synthetic cleaner", phoneE164: "+12025550123", isActive: true, preferredLanguage: "es", ttlockCardRef: "Cleaning Service-Demo" } });
  await db.propertyStaff.create({ data: { propertyId, staffMemberId: cleaner.id, role: "PRIMARY", isActive: true,
    cleaningDurationCommitmentMinutes: 180 } });
  await db.nfcCard.createMany({ data: [
    { propertyId, label: "Cleaning Service-Demo", ttlockCardId: 810002 },
    { propertyId, label: "Guest-Demo", ttlockCardId: 810001 },
    { propertyId, label: "Guest-Demo-2", ttlockCardId: 810003 },
  ] });
  await db.propertyGuestAgreement.create({ data: { propertyId, version: "1", title: "Demo",
    agreementText: "Synthetic terms", titleEs: "Acuerdo & Demo", agreementTextEs: "Condiciones guardadas\nTexto <sin HTML>",
    isActive: true, requiresIdentityVerification: true, requiresAgreementSignature: true } });
  const commercialProperty = await db.property.create({ data: { name: "Commercial sentinel", organizationId: org.id } });
  const commercial = await db.reservation.create({ data: { propertyId: commercialProperty.id,
    guestName: "Do not modify", source: "DIRECT_BOOKING", externalProvider: "PIN_GO_DIRECT",
    checkIn: new Date(Date.now() + 5 * 86400000), checkOut: new Date(Date.now() + 6 * 86400000) } });
  const env = { ...process.env, PIN_AI_GUEST_GATEWAY_ENABLED: "true", PIN_AI_RUNTIME_SHADOW_ENABLED: "true",
    PIN_AI_RUNTIME_REAL_READ_ENABLED: "true", PIN_AI_INCIDENT_ENABLED: "true", PIN_AI_INCIDENT_NOTIFICATIONS_ENABLED: "true",
    PIN_AI_HOST_INCIDENT_ENABLED: "true", OPENAI_API_KEY: "synthetic", PIN_AI_OPENAI_AGENT_ID: "agent_test123",
    PIN_AI_HOST_INCIDENT_KEYS: JSON.stringify({ test: "ab".repeat(32) }), PIN_AI_HOST_INCIDENT_KEY_ID: "test",
    TWILIO_ACCOUNT_SID: "synthetic", TWILIO_API_KEY: "synthetic", TWILIO_API_SECRET: "synthetic", TWILIO_FROM_NUMBER: "+12025550124" };
  const { ingestReservation } = await import("./ingest.service.js");
  const { completeInternalDemoSecurePrecheckin } = await import("./internal-demo-secure-precheckin.service.js");
  const { applyInternalDemoDirectBookingParity } = await import("./internal-demo-direct-booking-parity.service.js");
  const { dispatchPendingCleaningConfirmationForReservation } = await import("./cleaning-confirmation-dispatch.service.js");
  const { buildAdminDemoRunRouter } = await import("../routes/admin.demo.routes.js");
  const { cleaningConfirmRouter } = await import("../routes/cleaning-confirm.routes.js");
  const { default: express } = await import("express");
  let failOnce = true;
  let smsClock = new Date();
  const deps = { ingest: ingestReservation, secure: completeInternalDemoSecurePrecheckin,
    parity: async (...args: Parameters<typeof applyInternalDemoDirectBookingParity>) => {
      const result = await applyInternalDemoDirectBookingParity(...args);
      if (failOnce) { failOnce = false; throw new Error("synthetic response loss after provider acceptance"); }
      return result;
    }, cleaning: (p: Parameters<typeof dispatchPendingCleaningConfirmationForReservation>[0]) =>
      dispatchPendingCleaningConfirmationForReservation({ ...p, now: smsClock, send: async (to, body) => {
        assert.equal(to, cleaner.phoneE164); sms.push({ to, body }); return { sid: `SM-synthetic-${sms.length}` } as any;
      } }),
  };
  const app = express(); app.use(express.json()); app.use(express.urlencoded({ extended: false }));
  app.use((req: any, _res, next) => { req.user = { id: platform.id, orgId: org.id,
    role: req.headers["x-test-role"] ?? "PLATFORM_ADMIN", email: platform.email }; next(); });
  app.use(buildAdminDemoRunRouter(db, deps, {
    ...env, PIN_AI_INCIDENT_NOTIFICATIONS_ENABLED: undefined, GUEST_SMS_ENABLED: "0",
  }));
  app.use(cleaningConfirmRouter);
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>(resolve => server.once("listening", resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  async function command(body: any, role = "PLATFORM_ADMIN") {
    const response = await fetch(`${base}/api/internal/admin/demo/run`, { method: "POST",
      headers: { "Content-Type": "application/json", "x-test-role": role }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  }
  const checkIn = new Date(Date.now() + 2 * 86400000); checkIn.setUTCHours(13, 7, 0, 0);
  const checkOut = new Date(checkIn.getTime() + 20 * 60000);
  const input = { requestId: randomUUID(), checkIn: checkIn.toISOString(), checkOut: checkOut.toISOString(),
    guestName: "Synthetic guest", guestEmail: "guest@example.invalid", guestPhone: "+12025550125",
    preferredLanguage: "es", smsConsent: true, cleanerId: cleaner.id, primaryAdminEmail: principal.email, afterHoursAuthorized: true };
  let reservationId = "", token = "", number = "";

  await t.test("preparation names actual recipients; invalid data and non-platform actors write nothing", async () => {
    const { resolveInternalDemoPrimaryAdmin } = await import("./internal-demo-primary-admin.service.js");
    const { resolveOrganizationPrimaryAdmin } = await import("./organization-guest-email.service.js");
    assert.equal(await resolveOrganizationPrimaryAdmin(db, org.id), null, "commercial recipient policy is unchanged");
    assert.equal(await resolveInternalDemoPrimaryAdmin(db, org.id, undefined), null);
    assert.equal(await resolveInternalDemoPrimaryAdmin(db, commercialProperty.id, platform.id), null, "actor must belong to the organization");
    await db.dashboardUser.update({ where: { id: platform.id }, data: { role: "MEMBER" } });
    assert.equal(await resolveInternalDemoPrimaryAdmin(db, org.id, platform.id), null, "never fall back to a member or another platform admin");
    await db.dashboardUser.update({ where: { id: platform.id }, data: { role: "PLATFORM_ADMIN", isActive: false } });
    assert.equal(await resolveInternalDemoPrimaryAdmin(db, org.id, platform.id), null, "inactive actors are ineligible");
    await db.dashboardUser.update({ where: { id: platform.id }, data: { isActive: true } });
    await db.dashboardUser.update({ where: { id: orgAdmin.id }, data: { isActive: true } });
    assert.equal((await resolveInternalDemoPrimaryAdmin(db, org.id, platform.id))?.email, orgAdmin.email, "ORG_ADMIN still takes precedence");
    await db.dashboardUser.update({ where: { id: orgAdmin.id }, data: { isActive: false } });
    const prep = await (await fetch(`${base}/api/internal/admin/demo/preparation`)).json() as any;
    assert.equal(prep.data.ready, true, JSON.stringify(prep.data.blockers));
    assert.equal(prep.data.primaryAdmin.email, principal.email); assert.equal(prep.data.cleaner.id, cleaner.id);
    await db.nfcCard.updateMany({ where: { propertyId, ttlockCardId: 810003 }, data: { status: "RETIRED" } });
    const missingCard = await command(input);
    assert.equal(missingCard.status, 409); assert.equal(missingCard.body.safeToEdit, true);
    assert.match(missingCard.body.error, /GUEST_CARDS_UNAVAILABLE/);
    assert.equal(await db.reservation.count(), 1, "missing cards must block before any reservation or message");
    assert.equal(emails.length, 0);
    await db.nfcCard.updateMany({ where: { propertyId, ttlockCardId: 810003 }, data: { status: "AVAILABLE" } });
    assert.equal((await command(input, "ORG_ADMIN")).status, 403);
    const invalid = await command({ ...input, guestEmail: "invalid" });
    assert.equal(invalid.status, 400); assert.equal(invalid.body.safeToEdit, true);
    assert.equal(await db.reservation.count(), 1);
  });
  await t.test("provider acceptance followed by failure is resumable with the same PG number and token", async () => {
    const failed = await command(input);
    assert.equal(failed.status, 409); assert.equal(failed.body.ok, false);
    assert.ok(failed.body.data, JSON.stringify(failed.body));
    reservationId = failed.body.data.reservation.id; number = failed.body.data.reservation.reservationNumber;
    assert.match(number, /^PG-\d{4}-\d{6,}$/);
    const saved = await db.reservation.findUniqueOrThrow({ where: { id: reservationId } }); token = saved.guestToken!;
    assert.ok(token); assert.equal(emails.length, 2);
    const read = await (await fetch(`${base}/api/internal/admin/demo/runs/${input.requestId}`)).json() as any;
    assert.equal(read.data.lastError, "DEMO_CONFIRMATIONS_FAILED");
    const responses = await Promise.all([command(input), command(input)]);
    for (const response of responses) {
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(response.body.data.reservation.id, reservationId);
      assert.equal(response.body.data.reservation.reservationNumber, number);
      assert.equal(response.body.data.stage, "READY"); assert.equal(response.body.data.lastError, null);
      assert.ok(response.body.data.manageReservationUrl.endsWith(token));
    }
    assert.equal(await db.reservation.count(), 2); assert.equal(emails.length, 2); assert.equal(sms.length, 1);
    assert.deepEqual(emails.map(e => e.to), [input.guestEmail, principal.email]);
    assert.equal(emails[0].reply_to, principal.email, "guest replies reach the same Demo principal");
    assert.ok(emails[0].html.includes(`/booking/manage/${token}`));
    assert.ok(emails.every(e => e.html.includes("Demo") && e.html.includes(number)));
    assert.ok(emails[0].html.includes("sin cobro"));
    assert.ok(!emails[0].html.includes(`/guest/verify/${token}`));
    assert.ok(emails[0].html.includes("Acuerdo del huésped · Demo"));
    assert.ok(emails[0].html.includes("Acuerdo &amp; Demo"));
    assert.ok(emails[0].html.includes("Versión: 1"));
    assert.ok(emails[0].html.includes("Condiciones guardadas<br />Texto &lt;sin HTML&gt;"));
    assert.ok(emails[0].html.includes("aceptación es simulada"));
    assert.ok(!emails[0].html.includes("Synthetic terms"), "uses the localized reservation snapshot");
    assert.equal((saved.guestAgreementAcceptance as any).simulated, true);
    assert.equal((await command({ ...input, guestEmail: "changed@example.invalid" })).status, 409);
    assert.equal(emails.length, 2);
  });
  await t.test("Manage Reservation stays readable and Demo cannot cancel, modify or refund", async () => {
    const { getGuestCancellationPreview, cancelReservationFromGuestPortal } = await import("./guest-cancellation.service.js");
    const { getGuestReservationModificationOptions } = await import("./guest-reservation-modification.service.js");
    const { refundDirectBookingReservation } = await import("./direct-booking-refund.service.js");
    const preview = await getGuestCancellationPreview({ guestToken: token });
    assert.ok("reservation" in preview);
    assert.equal(preview.reservation.reservationNumber, number); assert.equal((preview as any).demo.timezone, property.timezone);
    assert.equal(preview.cancellationAllowed, false);
    await assert.rejects(cancelReservationFromGuestPortal({ guestToken: token }), /Commercial cancellation/);
    await assert.rejects(getGuestReservationModificationOptions({ guestToken: token }));
    await assert.rejects(refundDirectBookingReservation({ organizationId: org.id, reservationId }));
  });
  await t.test("provider delivery is separate from acceptance and unknown send results cannot duplicate a message", async () => {
    const { recordMessageDeliveryOutcome } = await import("./guest-journey-communications-delivery-outcome.service.js");
    const { sendInternalDemoMessage } = await import("./internal-demo-message.service.js");
    const mail = await db.messageLog.findFirstOrThrow({ where: { reservationId, communicationType: "DIRECT_BOOKING_GUEST_CONFIRMATION" } });
    assert.equal(mail.status, "SENT"); assert.notEqual(mail.providerDeliveryStatus, "DELIVERED");
    await recordMessageDeliveryOutcome(db, { provider: "resend", providerMessageId: mail.providerMessageId!,
      status: "DELIVERED", eventAt: new Date(), deliveredAt: new Date() });
    const read = await (await fetch(`${base}/api/internal/admin/demo/runs/${input.requestId}`)).json() as any;
    assert.equal(read.data.messages.find((m: any) => m.id === mail.id).delivery, "DELIVERED");
    const failedNotice = await db.messageLog.create({ data: {
      reservationId, propertyId, organizationId: org.id, channel: "email", to: "host@example.invalid",
      body: "Synthetic terminal provider rejection", provider: "resend", status: "FAILED_FINAL",
      communicationType: "PIN_AI_GUEST_INCIDENT_NOTICE", error: "NOTICE_SEND_FAILED_FINAL",
    } });
    const terminalRead = await (await fetch(`${base}/api/internal/admin/demo/runs/${input.requestId}`)).json() as any;
    assert.equal(terminalRead.data.messages.find((m: any) => m.id === failedNotice.id).delivery, "ATTENTION_REQUIRED");
    assert.equal((await db.messageLog.findUniqueOrThrow({ where: { id: failedNotice.id } })).status, "FAILED_FINAL");
    let attempts = 0;
    const uncertain = { prisma: db, reservationId, propertyId, organizationId: org.id, type: "SYNTHETIC_AMBIGUOUS_TEST",
      channel: "email" as const, to: "uncertain@example.invalid", body: "Synthetic test", send: async () => {
        attempts++; throw new Error("synthetic connection lost after send");
      } };
    assert.equal((await sendInternalDemoMessage(uncertain)).status, "ATTENTION_REQUIRED");
    assert.equal((await sendInternalDemoMessage(uncertain)).ok, false); assert.equal(attempts, 1);
  });
  await t.test("real grant service provisions exact minute window only on Demo lock; guest NFC uses same dates", async () => {
    const { activateGrant } = await import("./ttlock/ttlock.brain.js");
    const { assignNfcCards } = await import("./nfc.service.js");
    const grant = await db.accessGrant.findFirstOrThrow({ where: { reservationId, type: "GUEST" } });
    await activateGrant(grant.id);
    assert.equal((await db.accessGrant.findUniqueOrThrow({ where: { id: grant.id } })).status, "ACTIVE");
    const pin = hardware.find(h => h.path === "/v3/keyboardPwd/add")!;
    assert.equal(pin.form.get("startDate"), String(checkIn.getTime())); assert.equal(pin.form.get("endDate"), String(checkOut.getTime()));
    assert.equal(pin.form.get("addType"), "2");
    assert.equal(pin.form.get("keyboardPwd"), "0125"); assert.equal(pin.form.get("keyboardPwdType"), "3");
    const before = hardware.length; await activateGrant(grant.id); assert.equal(hardware.length, before);
    const cards = await assignNfcCards(db, { reservationId, propertyId, ttlockLockId: 29944630,
      role: "GUEST", startsAt: checkIn, endsAt: checkOut, count: 2, skipTtlock: true });
    assert.equal(cards.length, 2); assert.ok(cards.every(card => card.status === "SCHEDULED"));
    const { retryPendingNfcSync } = await import("./nfc-sync.service.js");
    await retryPendingNfcSync(db, checkIn, { guestOnly: true });
    const activeCards = await db.nfcAssignment.findMany({ where: { reservationId, role: "GUEST" } });
    assert.equal(activeCards.length, 2); assert.ok(activeCards.every(card => card.status === "ACTIVE"));
    const cardCalls = hardware.filter(call => call.path === "/v3/identityCard/changePeriod");
    assert.equal(cardCalls.length, 2);
    for (const call of cardCalls) {
      assert.equal(call.form.get("startDate"), String(checkIn.getTime()));
      assert.equal(call.form.get("endDate"), String(checkOut.getTime()));
      assert.equal(call.form.get("lockId"), "29944630");
    }
  });
  await t.test("guest gateway persists same-reservation conversation; incident reaches only principal and host reply returns to guest", async () => {
    const { GuestPinAIGateway, createGuestPinAIRuntimeRunner } = await import("../pin-ai/guest/guest-runtime-gateway.js");
    const { createTurnFixture } = await import("../pin-ai/runtime/runtime-turn.test-fixture.js");
    const { handleGuestIncident } = await import("../pin-ai/guest/guest-incident.service.js");
    const { deliverGuestIncidentNotice } = await import("../pin-ai/guest/guest-incident-notification.service.js");
    const { applyHostIncidentCommand, readPublishedIncidentUpdates, readHostIncident } = await import("../pin-ai/host/host-incident.service.js");
    openaiFixture = createTurnFixture({
      actions: turn => turn === 2 ? [{ name: "escalate_to_host", arguments: {
        operation: "REPORT", category: "HOT_WATER", guestQuotes: ["No sale agua caliente"], responseLanguage: "es",
      } }] : [],
      answer: () => "Synthetic model response; incident evidence is supplied by the real tool.",
    });
    let captured: any;
    const runtime = createGuestPinAIRuntimeRunner(env);
    const gateway = new GuestPinAIGateway(db as any, async (request, ...rest) => {
      captured = request; assert.equal(request.context.reservationId, reservationId);
      assert.equal(request.context.propertyId, propertyId); assert.equal(request.context.organizationId, org.id);
      return runtime(request, ...rest);
    }, true, () => new Date());
    await gateway.reply({ guestToken: token, message: "Cuál es el horario de mi reserva?" });
    await gateway.reply({ guestToken: token, message: "No sale agua caliente" });
    assert.equal(openaiFixture.createCount, 1, "conversation must resume the same provider session");
    assert.equal(openaiFixture.toolResults.length, 1, "real incident executor ran through the model transport");
    const tools = JSON.stringify((openaiFixture.createPayload.agent as any).tools);
    assert.ok(tools.includes("escalate_to_host")); assert.ok(!tools.includes("prepare_reservation_modification"));
    assert.ok((await db.pinAIGuestConversation.findUniqueOrThrow({ where: { reservationId } })).guestHistoryCiphertext);
    const report = { prisma: db, request: captured, guestToken: token, env, now: new Date(),
      args: { operation: "REPORT", category: "HOT_WATER", guestQuotes: ["No sale agua caliente"] } };
    const incident = await handleGuestIncident(report);
    assert.ok(incident?.reference);
    assert.equal((await handleGuestIncident(report))?.reference, incident.reference);
    await assert.rejects(handleGuestIncident({ ...report, guestToken: "wrong-token" }));
    const notices = await db.messageLog.findMany({ where: { reservationId, communicationType: "PIN_AI_GUEST_INCIDENT_HOST_NOTICE" } });
    assert.equal(notices.length, 1); assert.equal(notices[0].to, principal.email);
    await deliverGuestIncidentNotice({ prisma: db, message: notices[0], env, now: new Date() });
    assert.equal(emails.length, 3); assert.equal(emails[2].to, principal.email);
    const host = { prisma: db, env, actor: { id: principal.id, orgId: org.id }, reference: incident.reference };
    await applyHostIncidentCommand({ ...host, command: { operation: "ACKNOWLEDGE", expectedVersion: 0, requestId: randomUUID(), text: "" } });
    await applyHostIncidentCommand({ ...host, command: { operation: "PUBLISH", expectedVersion: 1, requestId: randomUUID(), text: "Recibimos tu reporte; revisaremos el agua caliente." } });
    const updates = await readPublishedIncidentUpdates({ prisma: db, env, guestToken: token });
    assert.equal(updates.updates.length, 1); assert.ok(updates.updates[0].text.includes("agua caliente"));
    await applyHostIncidentCommand({ ...host, command: { operation: "RESOLVE", expectedVersion: 2, requestId: randomUUID(), text: "Synthetic host resolution" } });
    assert.equal((await readHostIncident(host)).state, "RESOLVED");
    assert.equal((await readPublishedIncidentUpdates({ prisma: db, env, guestToken: token })).incidents[0].resolution, "RESOLVED");
  });
  await t.test("cleaner confirms from actual HTTP link, receives existing 30-minute window, starts and completes; credentials expire", async () => {
    const { sendCheckoutSms } = await import("./checkoutSms.service.js");
    let checkoutMessages = 0;
    const checkoutSend = async (to: string, body: string) => {
      assert.equal(to, input.guestPhone); assert.ok(body.includes("Synthetic Demo")); checkoutMessages++;
      return { sid: "SM-synthetic-checkout" } as any;
    };
    assert.equal((await sendCheckoutSms(db, reservationId, checkoutSend)).ok, true);
    await sendCheckoutSms(db, reservationId, checkoutSend); assert.equal(checkoutMessages, 1);
    const confirmation = await db.cleaningConfirmation.findFirstOrThrow({ where: { reservationId } });
    assert.ok(sms[0].body.includes(`/cleaning/confirm/${confirmation.token}`));
    const response = await fetch(`${base}/cleaning/confirm/${confirmation.token}/confirm`, { method: "POST" });
    assert.equal(response.status, 200, await response.text());
    assert.equal((await db.cleaningConfirmation.findUniqueOrThrow({ where: { id: confirmation.id } })).status, "CONFIRMED");
    const cleaning = await db.nfcAssignment.findFirstOrThrow({ where: { reservationId, role: "CLEANING" } });
    assert.equal(cleaning.startsAt.getTime(), checkOut.getTime() + 15 * 60000);
    assert.equal(cleaning.endsAt.getTime(), checkOut.getTime() + 45 * 60000);
    const { retryPendingNfcSync } = await import("./nfc-sync.service.js");
    await retryPendingNfcSync(db, checkOut, { assignmentId: cleaning.id });
    assert.equal((await db.nfcAssignment.findUniqueOrThrow({ where: { id: cleaning.id } })).status, "ACTIVE");
    const { materializeCleaningWorkSnapshot } = await import("./cleaning-work-snapshot.service.js");
    const { createCleaningWorkSnapshotStore } = await import("./cleaning-work-snapshot.prisma.js");
    const scope = { organizationId: org.id, propertyId, reservationId, confirmationId: confirmation.id, staffMemberId: cleaner.id };
    const result = await materializeCleaningWorkSnapshot(createCleaningWorkSnapshotStore(db), scope);
    assert.ok(result.work);
    const workInput = { reservationId, confirmationId: confirmation.id, staffMemberId: cleaner.id, workId: result.work.id };
    const { acceptCleaningTimingConsent } = await import("./cleaning-timing-consent.prisma.js");
    const { confirmCleaningStart } = await import("./cleaning-work-start.prisma.js");
    const { confirmCleaningCompletion } = await import("./cleaning-work-completion.prisma.js");
    await assert.rejects(confirmCleaningStart(db, workInput, cleaning.startsAt), /CONSENT_REQUIRED/);
    await acceptCleaningTimingConsent(db, workInput);
    await confirmCleaningStart(db, workInput, cleaning.startsAt);
    await confirmCleaningCompletion(db, workInput, new Date(cleaning.startsAt.getTime() + 10 * 60000));
    const { deactivateGrant } = await import("./ttlock/ttlock.brain.js");
    const { expireGuestNfcAssignments, expireCleaningNfcAssignments } = await import("./nfc-expire.service.js");
    const grant = await db.accessGrant.findFirstOrThrow({ where: { reservationId, type: "GUEST" } });
    await deactivateGrant(grant.id);
    await expireGuestNfcAssignments(db, checkOut); await expireCleaningNfcAssignments(db, cleaning.endsAt);
    assert.equal((await db.accessGrant.findUniqueOrThrow({ where: { id: grant.id } })).status, "REVOKED");
    assert.ok((await db.nfcAssignment.findMany({ where: { reservationId } })).every(a => a.status === "ENDED"));
    const read = await (await fetch(`${base}/api/internal/admin/demo/runs/${input.requestId}`)).json() as any;
    assert.ok(read.data.cleaningWork[0].completionConfirmedAt); assert.equal(read.data.demonstrationComplete, false);
  });
  for (const [label, hour, minute] of [["evening", 2, 10], ["across midnight", 3, 50]] as const) {
    await t.test(`repeat ${label} keeps configured cleaner policy and distinct canonical numbering`, async () => {
      const start = new Date(checkIn); start.setUTCDate(start.getUTCDate() + (hour === 2 ? 1 : 2)); start.setUTCHours(hour, minute, 0, 0);
      smsClock = start;
      const result = await command({ ...input, requestId: randomUUID(), checkIn: start.toISOString(), checkOut: new Date(start.getTime() + 20 * 60000).toISOString() });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.notEqual(result.body.data.reservation.reservationNumber, number);
      const id = result.body.data.reservation.id;
      const saved = await db.reservation.findUniqueOrThrow({ where: { id } });
      assert.equal(saved.stripePaymentIntentId, null); assert.equal(saved.amountCollected.toString(), "0");
    });
  }
  assert.equal(sms.length, 3);
  await t.test("agreement is escaped in English and excluded from commercial email; a missing Demo agreement cannot be sent", async () => {
    const { sendDirectBookingGuestConfirmation } = await import("../lib/mailer.js");
    const payload = { to: "guest@example.invalid", reservationNumber: number, propertyName: "Synthetic Demo", checkIn, checkOut,
      manageReservationUrl: `https://app.example.invalid/booking/manage/${token}`,
      verificationUrl: `https://api.example.invalid/guest/verify/${token}`, preferredLanguage: "en",
      demoGuestAgreement: { title: "Saved <agreement>", version: "v1", agreementText: "Saved & unchanged\nSecond line" } };
    await sendDirectBookingGuestConfirmation({ ...payload, demoSimulation: true });
    const demoHtml = emails.at(-1).html;
    assert.ok(demoHtml.includes("Guest agreement · Demo"));
    assert.ok(demoHtml.includes("Saved &lt;agreement&gt;"));
    assert.ok(demoHtml.includes("Version: v1"));
    assert.ok(demoHtml.includes("Saved &amp; unchanged<br />Second line"));
    assert.ok(demoHtml.includes("Acceptance is simulated"));
    await sendDirectBookingGuestConfirmation(payload);
    const commercialHtml = emails.at(-1).html;
    assert.ok(commercialHtml.includes(`/guest/verify/${token}`));
    assert.ok(commercialHtml.includes("sign the guest agreement"));
    assert.ok(!commercialHtml.includes("Saved &lt;agreement&gt;"));
    assert.ok(!commercialHtml.includes("Acceptance is simulated"));
    const before = emails.length;
    const { demoGuestAgreement: _agreement, ...withoutAgreement } = payload;
    await assert.rejects(sendDirectBookingGuestConfirmation({ ...withoutAgreement, demoSimulation: true }), /agreement snapshot is missing/);
    assert.equal(emails.length, before);
  });
  await t.test("new commercial accesses select gateway policy, preserve existing PINs and reconcile lost responses", async () => {
    const { activateGrant, deactivateGrant } = await import("./ttlock/ttlock.brain.js");
    const { decryptAccessCode } = await import("./access-code-crypto.service.js");
    const gatewayLock = await db.lock.create({ data: { propertyId: commercialProperty.id, ttlockLockId: 990001, isActive: true } });
    const offlineLock = await db.lock.create({ data: { propertyId: commercialProperty.id, ttlockLockId: 990002, isActive: true } });
    noGateway.add(990002);
    let sequence = 0;
    async function createGrant(lockId = gatewayLock.id, phone = "+12025550001") {
      const reservation = await db.reservation.create({ data: { propertyId: commercialProperty.id,
        guestName: "Synthetic policy test", guestPhone: phone, reservationNumber: `SYNTHETIC-POLICY-${++sequence}`,
        source: "DIRECT_BOOKING", externalProvider: "PIN_GO_DIRECT", status: "ACTIVE", paymentState: "PAID",
        checkIn, checkOut, verificationStatus: "NOT_REQUIRED", guestAgreementSnapshot: { requiresIdentityVerification: false },
        guestAgreementSignedAt: new Date(), guestAgreementAcceptance: { accepted: true }, verificationAcceptedRulesAt: new Date() } });
      return db.accessGrant.create({ data: { reservationId: reservation.id, lockId, type: "GUEST",
        method: "PASSCODE_TIMEBOUND", status: "PENDING", startsAt: checkIn, endsAt: checkOut } });
    }
    const first = await createGrant();
    const concurrent = await Promise.allSettled([activateGrant(first.id), activateGrant(first.id)]);
    assert.ok(concurrent.some(r => r.status === "fulfilled" && r.value.ok));
    for (const result of concurrent) if (result.status === "rejected") assert.match(String(result.reason), /LOCK_PROVISIONING_BUSY/);
    const saved = await db.accessGrant.findUniqueOrThrow({ where: { id: first.id } });
    const firstCode = await db.accessCode.findUniqueOrThrow({ where: { accessGrantId: first.id } });
    assert.equal(saved.status, "ACTIVE"); assert.equal(saved.accessCodeMasked, "****");
    assert.equal(decryptAccessCode(firstCode.accessCodeEnc!), "0001");
    assert.equal((saved.ttlockPayload as any).passcode.provisioningMethod, "CUSTOM_GATEWAY");
    assert.equal(firstCode.expiresAt!.getTime(), checkOut.getTime());
    const before = hardware.length;
    await activateGrant(first.id); assert.equal(hardware.length, before);
    assert.deepEqual(await db.accessCode.findUniqueOrThrow({ where: { accessGrantId: first.id } }), firstCode);

    const second = await createGrant(); await activateGrant(second.id);
    const secondCode = await db.accessCode.findUniqueOrThrow({ where: { accessGrantId: second.id } });
    assert.match(decryptAccessCode(secondCode.accessCodeEnc!), /^\d{8}$/);
    assert.equal((await db.accessGrant.findUniqueOrThrow({ where: { id: second.id } })).accessCodeMasked!.length, 7);
    assert.deepEqual(await db.accessCode.findUniqueOrThrow({ where: { accessGrantId: first.id } }), firstCode);

    const pending = await createGrant(gatewayLock.id, "+12025550234");
    customFailure = "accepted-timeout";
    await assert.rejects(activateGrant(pending.id), /RESULT_AMBIGUOUS/);
    assert.equal((await db.accessGrant.findUniqueOrThrow({ where: { id: pending.id } })).status, "PENDING");
    assert.equal(await db.accessCode.count({ where: { accessGrantId: pending.id } }), 0);
    const adds = hardware.filter(h => h.path === "/v3/keyboardPwd/add").length;
    customFailure = null; await activateGrant(pending.id);
    assert.equal(hardware.filter(h => h.path === "/v3/keyboardPwd/add").length, adds);
    assert.equal(decryptAccessCode((await db.accessCode.findUniqueOrThrow({ where: { accessGrantId: pending.id } })).accessCodeEnc!), "0234");

    const retry = await createGrant(gatewayLock.id, "+12025550345"); customFailure = "offline";
    await assert.rejects(activateGrant(retry.id), /SAFE_TO_RETRY/);
    assert.equal(await db.accessCode.count({ where: { accessGrantId: retry.id } }), 0);
    assert.equal((await db.accessGrant.findUniqueOrThrow({ where: { id: retry.id } })).status, "PENDING");
    customFailure = null;
    const competing = await createGrant(gatewayLock.id, "+12025550345"); await activateGrant(competing.id);
    assert.match(decryptAccessCode((await db.accessCode.findUniqueOrThrow({ where: { accessGrantId: competing.id } })).accessCodeEnc!), /^\d{8}$/,
      "a durable pending candidate is reserved even while absent from provider inventory");
    await activateGrant(retry.id);
    assert.equal(decryptAccessCode((await db.accessCode.findUniqueOrThrow({ where: { accessGrantId: retry.id } })).accessCodeEnc!), "0345");

    const timed = await createGrant(offlineLock.id); await activateGrant(timed.id);
    const timedSaved = await db.accessGrant.findUniqueOrThrow({ where: { id: timed.id } });
    assert.equal(timedSaved.status, "ACTIVE");
    assert.equal(hardware.some(h => h.path === "/v3/keyboardPwd/add" && h.form.get("lockId") === "990002"), false);
    assert.equal((timedSaved.ttlockPayload as any).passcode.provisioningMethod, "RANDOM_TIMED");

    await deactivateGrant(first.id);
    assert.equal((await db.accessGrant.findUniqueOrThrow({ where: { id: first.id } })).status, "REVOKED");
    assert.ok(pinInventory.get(990001)!.every(p => p.keyboardPwdId !== saved.ttlockKeyboardPwdId));
    assert.ok(pinInventory.get(990001)!.some(p => String(p.keyboardPwdId) === secondCode.keyboardPwdId));
    const deletion = hardware.filter(h => h.path === "/v3/keyboardPwd/delete").at(-1)!;
    assert.equal(deletion.form.get("keyboardPwdId"), String(saved.ttlockKeyboardPwdId));
    assert.equal(deletion.form.get("deleteType"), "2");
    const returning = await createGrant(); await activateGrant(returning.id);
    assert.equal(decryptAccessCode((await db.accessCode.findUniqueOrThrow({ where: { accessGrantId: returning.id } })).accessCodeEnc!), "0001",
      "a confirmed revoked and deleted PIN may be reused without rewriting the old access");
  });
  assert.deepEqual(await db.reservation.findUniqueOrThrow({ where: { id: commercial.id } }), commercial);
  assert.equal((await db.property.findUniqueOrThrow({ where: { id: propertyId } })).cleaningDurationMinutes, 240);
  assert.equal(await db.webhookEventIngest.count(), 0);
});
