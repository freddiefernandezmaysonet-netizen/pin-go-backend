import type {
  PinAIRuntimeRequest,
  PinAIRuntimeToolName,
} from "./contracts.js";
import {
  assertNoDirectIrreversibleAction,
  assertRuntimeRequestScoped,
  assertRuntimeToolEnabled,
} from "./policy.js";
import {
  assertMemoryMatchesRequest,
  type PinAIConversationMemory,
} from "./conversation-memory.js";

export interface PinAIRuntimeToolExecutor {
  execute(
    tool: PinAIRuntimeToolName,
    args: Readonly<Record<string, unknown>>,
    request: PinAIRuntimeRequest,
    memory: PinAIConversationMemory,
  ): Promise<Readonly<Record<string, unknown>>>;
}

export class GuardedPinAIRuntimeToolExecutor implements PinAIRuntimeToolExecutor {
  constructor(
    private readonly delegate: PinAIRuntimeToolExecutor,
  ) {}

  async execute(
    tool: PinAIRuntimeToolName,
    args: Readonly<Record<string, unknown>>,
    request: PinAIRuntimeRequest,
    memory: PinAIConversationMemory,
  ): Promise<Readonly<Record<string, unknown>>> {
    assertRuntimeRequestScoped(request);
    assertMemoryMatchesRequest(memory, request);
    assertRuntimeToolEnabled(tool);
    assertNoDirectIrreversibleAction(tool);

    const result = await this.delegate.execute(tool, args, request, memory);

    return {
      ...result,
      organizationId: request.context.organizationId,
      propertyId: request.context.propertyId,
      reservationId: request.context.reservationId,
      guestId: request.context.guestId,
    };
  }
}
