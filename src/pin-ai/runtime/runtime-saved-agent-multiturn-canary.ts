import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { PinAIRuntimeRequest, PinAIRuntimeToolName } from "./contracts.js";
import { GuardedPinAIModelAdapter } from "./model-adapter.js";
import { LunaRuntimeAdapter } from "./luna-runtime-adapter.js";
import { OpenAIAgentsRuntimeTransport, type RuntimeFetch,
  type CompletedRuntimeTurnEvidence } from "./openai-agents-runtime-transport.js";
import { PinAIShadowOrchestrator, type PinAIShadowRunResult } from "./shadow-orchestrator.js";
import type { PinAIRuntimeToolExecutor } from "./tool-executor.js";

type MultiTurnCanaryContext = Readonly<{
  organizationId: string;
  propertyId: string;
  reservationId: string;
  preferredLanguage: "en" | "es";
  currentLocalDateTime: string;
}>;

export type SavedAgentMultiTurnCanaryEnvironment = Readonly<{ apiKey: string; agentId: string }>;
type CanaryTurn = Readonly<{ result: PinAIShadowRunResult; evidence: CompletedRuntimeTurnEvidence }>;
type TurnSummary = Readonly<{
  toolCalls: readonly PinAIRuntimeToolName[];
  requiresHumanReview: boolean;
  responseLength: number;
}>;
export type SavedAgentMultiTurnCanaryResult = Readonly<{
  sessionId: string;
  firstTurn: TurnSummary;
  secondTurn: TurnSummary;
  actionsExecuted: false;
  databaseWrites: false;
  operationalWrites: false;
  escalationCreated: false;
  webSearchUsed: false;
  semanticContinuity: true;
  distinctTurns: true;
  freshResponsesVerified: true;
}>;

export function assertSavedAgentMultiTurnCanaryEnvironment(
  env: NodeJS.ProcessEnv,
): SavedAgentMultiTurnCanaryEnvironment {
  if (env.PIN_AI_RUNTIME_MULTITURN_CANARY_ENABLED !== "true") throw new Error("PIN_AI_RUNTIME_MULTITURN_CANARY_DISABLED");
  if (env.PIN_AI_RUNTIME_SHADOW_ENABLED !== "true") throw new Error("PIN_AI_RUNTIME_SHADOW_DISABLED");
  if (env.PIN_AI_RUNTIME_REAL_READ_ENABLED !== "true") throw new Error("PIN_AI_RUNTIME_REAL_READ_DISABLED");
  if (env.PIN_AI_RUNTIME_WEB_SEARCH_ENABLED === "true") throw new Error("PIN_AI_RUNTIME_MULTITURN_WEB_SEARCH_MUST_BE_DISABLED");
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("PIN_AI_RUNTIME_OPENAI_API_KEY_MISSING");
  const agentId = env.PIN_AI_OPENAI_AGENT_ID;
  if (!agentId || !/^agent_[A-Za-z0-9]+$/.test(agentId)) throw new Error("PIN_AI_RUNTIME_OPENAI_AGENT_ID_MISSING_OR_INVALID");
  return { apiKey, agentId };
}

export async function runSavedAgentMultiTurnCanary(input: Readonly<{
  apiKey: string;
  agentId: string;
  context: MultiTurnCanaryContext;
  fetchImpl: RuntimeFetch;
  tools: PinAIRuntimeToolExecutor;
  maxPolls?: number;
  pollDelayMs?: number;
}>): Promise<SavedAgentMultiTurnCanaryResult> {
  // Unpredictable per run; never log it or repeat it in the second request.
  const marker = `PIN-AI-${randomBytes(16).toString("hex").toUpperCase()}`;
  const firstRequest = buildRequest(input.context, input.context.preferredLanguage === "es"
    ? `Para esta prueba, recuerda el código ${marker}. No repitas el código en esta primera respuesta. ¿Cuál es el estado actual de mi estadía y cuál es el próximo paso?`
    : `For this test, remember the code ${marker}. Do not repeat the code in this first reply. What is the current status of my stay and what is the next step?`);
  console.log("PIN_AI_RUNTIME_MULTITURN_FIRST_TURN_BEGIN");
  const firstTurn = await runTurn({ ...input, request: firstRequest });
  assertShadowTurn(firstTurn.result);
  if (firstTurn.result.response.responseText.includes(marker)) {
    throw new Error("PIN_AI_RUNTIME_MULTITURN_MARKER_ECHOED_ON_FIRST_TURN");
  }
  console.log("PIN_AI_RUNTIME_MULTITURN_FIRST_TURN_COMPLETE");
  const sessionId = firstTurn.result.response.openaiSessionId;
  if (!sessionId) throw new Error("PIN_AI_RUNTIME_MULTITURN_SESSION_ID_MISSING");

  const secondRequest = buildRequest(input.context, input.context.preferredLanguage === "es"
    ? "¿Cuál fue el código que te di en mi mensaje anterior? Responde solo con el código."
    : "What code did I give you in my previous message? Reply with only the code.");
  console.log("PIN_AI_RUNTIME_MULTITURN_SECOND_TURN_BEGIN");
  const secondTurn = await runTurn({ ...input, resumeSessionId: sessionId, request: secondRequest });
  assertShadowTurn(secondTurn.result);
  if (secondTurn.result.response.openaiSessionId !== sessionId ||
      firstTurn.evidence.sessionId !== sessionId || secondTurn.evidence.sessionId !== sessionId) {
    throw new Error("PIN_AI_RUNTIME_MULTITURN_SESSION_ID_CHANGED");
  }
  if (firstTurn.evidence.turnId === secondTurn.evidence.turnId ||
      firstTurn.evidence.assistantMessageId === secondTurn.evidence.assistantMessageId) {
    throw new Error("PIN_AI_RUNTIME_MULTITURN_STALE_TURN_OR_MESSAGE");
  }
  // Exact equality, not a substring of a repeated acknowledgement or old reply.
  if (secondTurn.result.response.responseText.trim() !== marker) {
    throw new Error("PIN_AI_RUNTIME_MULTITURN_SEMANTIC_CONTINUITY_FAILED");
  }
  const allCalls = [...firstTurn.result.response.toolCalls, ...secondTurn.result.response.toolCalls];
  if (allCalls.some((call) => call.name === "search_local_places")) {
    throw new Error("PIN_AI_RUNTIME_MULTITURN_FORBIDDEN_TOOL_USED");
  }
  console.log("PIN_AI_RUNTIME_MULTITURN_SECOND_TURN_COMPLETE");
  return {
    sessionId,
    firstTurn: summarizeTurn(firstTurn.result),
    secondTurn: summarizeTurn(secondTurn.result),
    actionsExecuted: false, databaseWrites: false, operationalWrites: false,
    escalationCreated: false, webSearchUsed: false,
    semanticContinuity: true, distinctTurns: true, freshResponsesVerified: true,
  };
}

async function runTurn(input: Readonly<{
  apiKey: string;
  agentId: string;
  resumeSessionId?: string;
  request: PinAIRuntimeRequest;
  fetchImpl: RuntimeFetch;
  tools: PinAIRuntimeToolExecutor;
  maxPolls?: number;
  pollDelayMs?: number;
}>): Promise<CanaryTurn> {
  const transport = new OpenAIAgentsRuntimeTransport({
    enabled: true, apiKey: input.apiKey, agentId: input.agentId,
    ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
    model: "gpt-5.6-luna", webSearch: { enabled: false },
    maxPolls: input.maxPolls ?? 50, pollDelayMs: input.pollDelayMs ?? 500,
  }, input.fetchImpl);
  const model = new GuardedPinAIModelAdapter(new LunaRuntimeAdapter(transport));
  const result = await new PinAIShadowOrchestrator(model, input.tools).run(input.request);
  const evidence = transport.getCompletedTurnEvidence();
  if (!evidence || evidence.status !== "completed") {
    throw new Error("PIN_AI_RUNTIME_MULTITURN_COMPLETED_TURN_EVIDENCE_MISSING");
  }
  return { result, evidence };
}

function buildRequest(context: MultiTurnCanaryContext, message: string): PinAIRuntimeRequest {
  return {
    context: { ...context, guestId: "runtime-multiturn-staging-guest" },
    conversation: [{ role: "guest", content: message }],
  };
}
function assertShadowTurn(result: PinAIShadowRunResult): void {
  if (result.mode !== "SHADOW" || result.actionsExecuted !== false) throw new Error("PIN_AI_RUNTIME_MULTITURN_SHADOW_INVARIANT_FAILED");
  if (result.response.escalationCreated !== false) throw new Error("PIN_AI_RUNTIME_MULTITURN_ESCALATION_CREATED");
  if (result.response.webSearch?.enabled === true || result.response.webSearch?.used === true) throw new Error("PIN_AI_RUNTIME_MULTITURN_WEB_SEARCH_USED");
  if (!result.response.responseText.trim()) throw new Error("PIN_AI_RUNTIME_MULTITURN_EMPTY_RESPONSE");
}
function summarizeTurn(result: PinAIShadowRunResult): TurnSummary {
  return { toolCalls: result.response.toolCalls.map((call) => call.name),
    requiresHumanReview: result.response.requiresHumanReview,
    responseLength: result.response.responseText.trim().length };
}

async function main(): Promise<void> {
  const { apiKey, agentId } = assertSavedAgentMultiTurnCanaryEnvironment(process.env);
  // Tests/imports do not initialize Prisma or operational adapters.
  const { prisma } = await import("../../lib/prisma.js");
  const { createPinGoRuntimeReadToolExecutor } = await import("./pin-go-runtime-tools.js");
  try {
    const reservation = await prisma.reservation.findFirst({
      where: { status: "ACTIVE", property: { status: "ACTIVE" } },
      orderBy: { updatedAt: "desc" },
      select: { id: true, propertyId: true, preferredLanguage: true,
        property: { select: { organizationId: true } } },
    });
    if (!reservation) throw new Error("PIN_AI_RUNTIME_STAGING_ACTIVE_RESERVATION_NOT_FOUND");
    let outboundCalls = 0;
    const guardedFetch: RuntimeFetch = async (url, init) => {
      outboundCalls += 1;
      if (outboundCalls > 60) throw new Error("PIN_AI_RUNTIME_MULTITURN_NETWORK_CALL_LIMIT");
      try {
        const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
        return { ok: response.ok, status: response.status, json: async () => response.json() };
      } catch (error) {
        if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
          throw new Error("PIN_AI_RUNTIME_MULTITURN_FETCH_TIMEOUT");
        }
        throw error;
      }
    };
    console.log("PIN_AI_RUNTIME_MULTITURN_STARTED:gpt-5.6-luna");
    const result = await runSavedAgentMultiTurnCanary({ apiKey, agentId,
      context: { organizationId: reservation.property.organizationId, propertyId: reservation.propertyId,
        reservationId: reservation.id, preferredLanguage: reservation.preferredLanguage === "es" ? "es" : "en",
        currentLocalDateTime: new Date().toISOString() },
      fetchImpl: guardedFetch, tools: createPinGoRuntimeReadToolExecutor(),
    });
    console.log(JSON.stringify({ runtime: "pin-ai-v1", mode: "SHADOW_SAVED_AGENT_MULTITURN",
      model: "gpt-5.6-luna", sameSession: true,
      firstTurn: result.firstTurn, secondTurn: result.secondTurn,
      escalationCreated: result.escalationCreated, actionsExecuted: result.actionsExecuted,
      databaseWrites: result.databaseWrites, operationalWrites: result.operationalWrites,
      webSearchUsed: result.webSearchUsed, semanticContinuity: result.semanticContinuity,
      distinctTurns: result.distinctTurns, freshResponsesVerified: result.freshResponsesVerified, outboundCalls,
    }));
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

const entryPoint = process.argv[1];
if (entryPoint && import.meta.url === pathToFileURL(entryPoint).href) {
  main().catch((error: unknown) => {
    const code = error instanceof Error ? error.message.match(/^PIN_AI_[A-Z0-9_]+/)?.[0] : undefined;
    console.error(`PIN_AI_RUNTIME_MULTITURN_FAILED:${code ?? "UNKNOWN_ERROR"}`);
    process.exitCode = 1;
  });
}
