import { pathToFileURL } from "node:url";

import { prisma } from "../../lib/prisma.js";
import type {
  PinAIRuntimeRequest,
  PinAIRuntimeToolName,
} from "./contracts.js";
import { GuardedPinAIModelAdapter } from "./model-adapter.js";
import { LunaRuntimeAdapter } from "./luna-runtime-adapter.js";
import {
  OpenAIAgentsRuntimeTransport,
  type RuntimeFetch,
} from "./openai-agents-runtime-transport.js";
import {
  PinAIShadowOrchestrator,
  type PinAIShadowRunResult,
} from "./shadow-orchestrator.js";
import {
  createPinGoRuntimeReadToolExecutor,
} from "./pin-go-runtime-tools.js";
import type { PinAIRuntimeToolExecutor } from "./tool-executor.js";

type MultiTurnCanaryContext = Readonly<{
  organizationId: string;
  propertyId: string;
  reservationId: string;
  preferredLanguage: "en" | "es";
  currentLocalDateTime: string;
}>;

export type SavedAgentMultiTurnCanaryEnvironment = Readonly<{
  apiKey: string;
  agentId: string;
}>;

export type SavedAgentMultiTurnCanaryResult = Readonly<{
  sessionId: string;
  firstTurn: Readonly<{
    toolCalls: readonly PinAIRuntimeToolName[];
    requiresHumanReview: boolean;
    responseLength: number;
  }>;
  secondTurn: Readonly<{
    toolCalls: readonly PinAIRuntimeToolName[];
    requiresHumanReview: boolean;
    responseLength: number;
  }>;
  actionsExecuted: false;
  databaseWrites: false;
  operationalWrites: false;
  escalationCreated: false;
  webSearchUsed: false;
}>;

export function assertSavedAgentMultiTurnCanaryEnvironment(
  env: NodeJS.ProcessEnv,
): SavedAgentMultiTurnCanaryEnvironment {
  if (env.PIN_AI_RUNTIME_MULTITURN_CANARY_ENABLED !== "true") {
    throw new Error("PIN_AI_RUNTIME_MULTITURN_CANARY_DISABLED");
  }
  if (env.PIN_AI_RUNTIME_SHADOW_ENABLED !== "true") {
    throw new Error("PIN_AI_RUNTIME_SHADOW_DISABLED");
  }
  if (env.PIN_AI_RUNTIME_REAL_READ_ENABLED !== "true") {
    throw new Error("PIN_AI_RUNTIME_REAL_READ_DISABLED");
  }
  if (env.PIN_AI_RUNTIME_WEB_SEARCH_ENABLED === "true") {
    throw new Error("PIN_AI_RUNTIME_MULTITURN_WEB_SEARCH_MUST_BE_DISABLED");
  }

  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("PIN_AI_RUNTIME_OPENAI_API_KEY_MISSING");
  }

  const agentId = env.PIN_AI_OPENAI_AGENT_ID;
  if (!agentId || !/^agent_[A-Za-z0-9]+$/.test(agentId)) {
    throw new Error("PIN_AI_RUNTIME_OPENAI_AGENT_ID_MISSING_OR_INVALID");
  }

  return { apiKey, agentId };
}

export async function runSavedAgentMultiTurnCanary(input: Readonly<{
  apiKey: string;
  agentId: string;
  context: MultiTurnCanaryContext;
  fetchImpl: RuntimeFetch;
  tools: PinAIRuntimeToolExecutor;
}>): Promise<SavedAgentMultiTurnCanaryResult> {
  const firstRequest = buildRequest(
    input.context,
    input.context.preferredLanguage === "es"
      ? "¿Cuál es el estado actual de mi estadía y cuál es el próximo paso?"
      : "What is the current status of my stay and what is the next step?",
  );

  console.log("PIN_AI_RUNTIME_MULTITURN_FIRST_TURN_BEGIN");

  const firstTurn = await runTurn({
    apiKey: input.apiKey,
    agentId: input.agentId,
    request: firstRequest,
    fetchImpl: input.fetchImpl,
    tools: input.tools,
  });

  assertShadowTurn(firstTurn);
  console.log("PIN_AI_RUNTIME_MULTITURN_FIRST_TURN_COMPLETE");
  const sessionId = firstTurn.response.openaiSessionId;
  if (!sessionId) {
    throw new Error("PIN_AI_RUNTIME_MULTITURN_SESSION_ID_MISSING");
  }

  const secondRequest = buildRequest(
    input.context,
    input.context.preferredLanguage === "es"
      ? "Basado en lo que acabas de decirme, ¿qué falta antes de que mi acceso esté listo?"
      : "Based on what you just told me, what is still needed before my access is ready?",
  );

  console.log("PIN_AI_RUNTIME_MULTITURN_SECOND_TURN_BEGIN");

  const secondTurn = await runTurn({
    apiKey: input.apiKey,
    agentId: input.agentId,
    resumeSessionId: sessionId,
    request: secondRequest,
    fetchImpl: input.fetchImpl,
    tools: input.tools,
  });

  assertShadowTurn(secondTurn);
  console.log("PIN_AI_RUNTIME_MULTITURN_SECOND_TURN_COMPLETE");
  if (secondTurn.response.openaiSessionId !== sessionId) {
    throw new Error("PIN_AI_RUNTIME_MULTITURN_SESSION_ID_CHANGED");
  }

  const allToolCalls = [
    ...firstTurn.response.toolCalls,
    ...secondTurn.response.toolCalls,
  ];
  if (allToolCalls.some((call) => call.name === "search_local_places")) {
    throw new Error("PIN_AI_RUNTIME_MULTITURN_FORBIDDEN_TOOL_USED");
  }

  return {
    sessionId,
    firstTurn: summarizeTurn(firstTurn),
    secondTurn: summarizeTurn(secondTurn),
    actionsExecuted: false,
    databaseWrites: false,
    operationalWrites: false,
    escalationCreated: false,
    webSearchUsed: false,
  };
}

async function runTurn(input: Readonly<{
  apiKey: string;
  agentId: string;
  resumeSessionId?: string;
  request: PinAIRuntimeRequest;
  fetchImpl: RuntimeFetch;
  tools: PinAIRuntimeToolExecutor;
}>): Promise<PinAIShadowRunResult> {
  const transport = new OpenAIAgentsRuntimeTransport(
    {
      enabled: true,
      apiKey: input.apiKey,
      agentId: input.agentId,
      ...(input.resumeSessionId
        ? { resumeSessionId: input.resumeSessionId }
        : {}),
      model: "gpt-5.6-luna",
      webSearch: { enabled: false },
      maxPolls: 50,
      pollDelayMs: 500,
    },
    input.fetchImpl,
  );

  const model = new GuardedPinAIModelAdapter(
    new LunaRuntimeAdapter(transport),
  );

  return new PinAIShadowOrchestrator(model, input.tools).run(input.request);
}

function buildRequest(
  context: MultiTurnCanaryContext,
  message: string,
): PinAIRuntimeRequest {
  return {
    context: {
      organizationId: context.organizationId,
      propertyId: context.propertyId,
      reservationId: context.reservationId,
      guestId: "runtime-multiturn-staging-guest",
      currentLocalDateTime: context.currentLocalDateTime,
      preferredLanguage: context.preferredLanguage,
    },
    conversation: [{ role: "guest", content: message }],
  };
}

function assertShadowTurn(result: PinAIShadowRunResult): void {
  if (result.mode !== "SHADOW" || result.actionsExecuted !== false) {
    throw new Error("PIN_AI_RUNTIME_MULTITURN_SHADOW_INVARIANT_FAILED");
  }
  if (result.response.escalationCreated !== false) {
    throw new Error("PIN_AI_RUNTIME_MULTITURN_ESCALATION_CREATED");
  }
  if (result.response.webSearch?.used === true) {
    throw new Error("PIN_AI_RUNTIME_MULTITURN_WEB_SEARCH_USED");
  }
  if (!result.response.responseText.trim()) {
    throw new Error("PIN_AI_RUNTIME_MULTITURN_EMPTY_RESPONSE");
  }
}

function summarizeTurn(
  result: PinAIShadowRunResult,
): SavedAgentMultiTurnCanaryResult["firstTurn"] {
  return {
    toolCalls: result.response.toolCalls.map((call) => call.name),
    requiresHumanReview: result.response.requiresHumanReview,
    responseLength: result.response.responseText.trim().length,
  };
}

async function main(): Promise<void> {
  const { apiKey, agentId } =
    assertSavedAgentMultiTurnCanaryEnvironment(process.env);

  const reservation = await prisma.reservation.findFirst({
    where: {
      status: "ACTIVE",
      property: { status: "ACTIVE" },
    },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      propertyId: true,
      preferredLanguage: true,
      property: {
        select: {
          organizationId: true,
        },
      },
    },
  });

  if (!reservation) {
    throw new Error("PIN_AI_RUNTIME_STAGING_ACTIVE_RESERVATION_NOT_FOUND");
  }

  let outboundCalls = 0;
  const guardedFetch: RuntimeFetch = async (url, init) => {
    outboundCalls += 1;
    if (outboundCalls > 60) {
      throw new Error("PIN_AI_RUNTIME_MULTITURN_NETWORK_CALL_LIMIT");
    }

    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError")
      ) {
        throw new Error("PIN_AI_RUNTIME_MULTITURN_FETCH_TIMEOUT");
      }
      throw error;
    }
    return {
      ok: response.ok,
      status: response.status,
      json: async () => response.json(),
    };
  };

  console.log("PIN_AI_RUNTIME_MULTITURN_STARTED:gpt-5.6-luna");

  const result = await runSavedAgentMultiTurnCanary({
    apiKey,
    agentId,
    context: {
      organizationId: reservation.property.organizationId,
      propertyId: reservation.propertyId,
      reservationId: reservation.id,
      preferredLanguage: reservation.preferredLanguage === "es" ? "es" : "en",
      currentLocalDateTime: new Date().toISOString(),
    },
    fetchImpl: guardedFetch,
    tools: createPinGoRuntimeReadToolExecutor(),
  });

  console.log(
    JSON.stringify({
      runtime: "pin-ai-v1",
      mode: "SHADOW_SAVED_AGENT_MULTITURN",
      model: "gpt-5.6-luna",
      sameSession: true,
      firstTurn: result.firstTurn,
      secondTurn: result.secondTurn,
      escalationCreated: result.escalationCreated,
      actionsExecuted: result.actionsExecuted,
      databaseWrites: result.databaseWrites,
      operationalWrites: result.operationalWrites,
      webSearchUsed: result.webSearchUsed,
      outboundCalls,
    }),
  );
}

function isMainModule(): boolean {
  const entryPoint = process.argv[1];
  return Boolean(
    entryPoint &&
      import.meta.url === pathToFileURL(entryPoint).href,
  );
}

if (isMainModule()) {
  main()
    .catch((error: unknown) => {
      const message =
        error instanceof Error ? error.message : "UNKNOWN_ERROR";
      console.error(`PIN_AI_RUNTIME_MULTITURN_FAILED:${message}`);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect().catch(() => undefined);
    });
}
