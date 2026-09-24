import { pathToFileURL } from "node:url";

import type { GuestPinAIGatewayResponse } from "./guest-runtime-gateway.js";

type GatewayLike = Readonly<{
  reply(input: Readonly<{ guestToken: unknown; message: unknown }>): Promise<GuestPinAIGatewayResponse>;
}>;

type ConversationState = Readonly<{
  openaiSessionId: string | null;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  lastErrorCode: string | null;
}>;

export type GuestGatewayCanaryResult = Readonly<{
  sameSession: true;
  conversationPersisted: true;
  databaseWrites: true;
  operationalWrites: false;
  actionsExecuted: false;
  escalationCreated: false;
  humanReviewObserved: true;
  webSearchUsed: false;
  turnResponseLengths: readonly [number, number, number];
}>;

export function assertGuestGatewayCanaryEnvironment(env: NodeJS.ProcessEnv): void {
  if (env.PIN_AI_GUEST_GATEWAY_CANARY_ENABLED !== "true") {
    throw new Error("PIN_AI_GUEST_GATEWAY_CANARY_DISABLED");
  }
  if (env.PIN_AI_GUEST_GATEWAY_ENABLED !== "true") {
    throw new Error("PIN_AI_GUEST_GATEWAY_DISABLED");
  }
  if (env.PIN_AI_RUNTIME_SHADOW_ENABLED !== "true") {
    throw new Error("PIN_AI_RUNTIME_SHADOW_DISABLED");
  }
  if (env.PIN_AI_RUNTIME_REAL_READ_ENABLED !== "true") {
    throw new Error("PIN_AI_RUNTIME_REAL_READ_DISABLED");
  }
  if (env.PIN_AI_RUNTIME_WEB_SEARCH_ENABLED === "true") {
    throw new Error("PIN_AI_GUEST_GATEWAY_CANARY_WEB_SEARCH_MUST_BE_DISABLED");
  }
  if (!env.OPENAI_API_KEY) {
    throw new Error("PIN_AI_RUNTIME_OPENAI_API_KEY_MISSING");
  }
  if (!env.PIN_AI_OPENAI_AGENT_ID || !/^agent_[A-Za-z0-9]+$/.test(env.PIN_AI_OPENAI_AGENT_ID)) {
    throw new Error("PIN_AI_RUNTIME_OPENAI_AGENT_ID_MISSING_OR_INVALID");
  }
}

export async function runGuestGatewayCanary(input: Readonly<{
  gateway: GatewayLike;
  guestToken: string;
  readConversationState: () => Promise<ConversationState | null>;
}>): Promise<GuestGatewayCanaryResult> {
  const messages = [
    "Hola, ¿cuál es el estado actual de mi estadía y qué falta para que mi acceso esté listo?",
    "Gracias. ¿Cuál es la hora de checkout y qué regla importante de la propiedad debo recordar?",
    "Necesito una excepción con revisión humana del host: quiero salir a la 1:00 PM. No cambies la reserva ni ejecutes nada; dime si requiere revisión.",
  ] as const;

  const responses: GuestPinAIGatewayResponse[] = [];
  let persistedSessionId: string | null = null;

  for (const message of messages) {
    const response = await input.gateway.reply({
      guestToken: input.guestToken,
      message,
    });
    assertShadowGatewayResponse(response);
    responses.push(response);

    const state = await input.readConversationState();
    if (!state?.openaiSessionId) {
      throw new Error("PIN_AI_GUEST_GATEWAY_CANARY_SESSION_NOT_PERSISTED");
    }
    if (state.leaseToken !== null || state.leaseExpiresAt !== null) {
      throw new Error("PIN_AI_GUEST_GATEWAY_CANARY_LEASE_NOT_RELEASED");
    }
    if (state.lastErrorCode !== null) {
      throw new Error("PIN_AI_GUEST_GATEWAY_CANARY_LAST_ERROR_PRESENT");
    }
    if (persistedSessionId && persistedSessionId !== state.openaiSessionId) {
      throw new Error("PIN_AI_GUEST_GATEWAY_CANARY_SESSION_CHANGED");
    }
    persistedSessionId = state.openaiSessionId;
  }

  if (responses[2]?.requiresHumanReview !== true) {
    throw new Error("PIN_AI_GUEST_GATEWAY_CANARY_HUMAN_REVIEW_NOT_OBSERVED");
  }

  return {
    sameSession: true,
    conversationPersisted: true,
    databaseWrites: true,
    operationalWrites: false,
    actionsExecuted: false,
    escalationCreated: false,
    humanReviewObserved: true,
    webSearchUsed: false,
    turnResponseLengths: [
      responses[0]?.reply.trim().length ?? 0,
      responses[1]?.reply.trim().length ?? 0,
      responses[2]?.reply.trim().length ?? 0,
    ],
  };
}

function assertShadowGatewayResponse(response: GuestPinAIGatewayResponse): void {
  if (
    response.mode !== "SHADOW" ||
    response.conversationPersisted !== true ||
    response.actionsExecuted !== false ||
    response.operationalWrites !== false ||
    response.escalationCreated !== false ||
    response.webSearch.enabled !== false ||
    response.webSearch.used !== false ||
    !response.reply.trim()
  ) {
    throw new Error("PIN_AI_GUEST_GATEWAY_CANARY_SHADOW_INVARIANT_FAILED");
  }
}

async function main(): Promise<void> {
  assertGuestGatewayCanaryEnvironment(process.env);

  const [{ prisma }, { GuestPinAIGateway, createGuestPinAIRuntimeRunner }] = await Promise.all([
    import("../../lib/prisma.js"),
    import("./guest-runtime-gateway.js"),
  ]);

  try {
    const migrationRows = await prisma.$queryRaw<
      Array<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }>
    >`
      SELECT "migration_name", "finished_at", "rolled_back_at"
      FROM "_prisma_migrations"
      WHERE "migration_name" = '20260921143000_add_pin_ai_guest_conversation_sessions'
      LIMIT 1
    `;
    const migration = migrationRows[0];
    if (!migration || migration.finished_at === null || migration.rolled_back_at !== null) {
      throw new Error("PIN_AI_GUEST_GATEWAY_CANARY_MIGRATION_NOT_APPLIED");
    }

    const now = new Date();
    const reservation = await prisma.reservation.findFirst({
      where: {
        status: "ACTIVE",
        guestToken: { not: null },
        guestTokenExpiresAt: { gt: now },
        property: { status: "ACTIVE" },
        pinAIGuestConversation: null,
      },
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        guestToken: true,
        updatedAt: true,
      },
    });

    if (!reservation?.guestToken) {
      throw new Error("PIN_AI_GUEST_GATEWAY_CANARY_FRESH_RESERVATION_NOT_FOUND");
    }

    const reservationUpdatedAtBefore = reservation.updatedAt.getTime();
    const gateway = new GuestPinAIGateway(
      prisma,
      createGuestPinAIRuntimeRunner(process.env),
      true,
    );

    console.log("PIN_AI_GUEST_GATEWAY_CANARY_STARTED:gpt-5.6-luna");

    const result = await runGuestGatewayCanary({
      gateway,
      guestToken: reservation.guestToken,
      readConversationState: async () =>
        prisma.pinAIGuestConversation.findUnique({
          where: { reservationId: reservation.id },
          select: {
            openaiSessionId: true,
            leaseToken: true,
            leaseExpiresAt: true,
            lastErrorCode: true,
          },
        }),
    });

    const reservationAfter = await prisma.reservation.findUnique({
      where: { id: reservation.id },
      select: { updatedAt: true },
    });
    if (!reservationAfter || reservationAfter.updatedAt.getTime() !== reservationUpdatedAtBefore) {
      throw new Error("PIN_AI_GUEST_GATEWAY_CANARY_RESERVATION_MUTATED");
    }

    console.log(JSON.stringify({
      runtime: "pin-ai-v1",
      mode: "SHADOW_GUEST_GATEWAY_CANARY",
      model: "gpt-5.6-luna",
      sameSession: result.sameSession,
      conversationPersisted: result.conversationPersisted,
      databaseWrites: result.databaseWrites,
      operationalWrites: result.operationalWrites,
      actionsExecuted: result.actionsExecuted,
      escalationCreated: result.escalationCreated,
      humanReviewObserved: result.humanReviewObserved,
      webSearchUsed: result.webSearchUsed,
      turnResponseLengths: result.turnResponseLengths,
    }));
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    const code = error instanceof Error
      ? error.message.match(/^PIN_AI_[A-Z0-9_]+/)?.[0]
      : undefined;
    const providerCode =
      error && typeof error === "object" && "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
        ? String((error as { code: string }).code).replace(/[^A-Z0-9_]/gi, "").slice(0, 32)
        : undefined;
    console.error(
      `PIN_AI_GUEST_GATEWAY_CANARY_FAILED:${code ?? providerCode ?? "UNKNOWN_ERROR"}`,
    );
    process.exitCode = 1;
  });
}
