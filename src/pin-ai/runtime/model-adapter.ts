import type {
  PinAIRuntimeRequest,
  PinAIRuntimeResponse,
} from "./contracts.js";
import type {
  PinAIConversationMemory,
} from "./conversation-memory.js";
import type {
  PinAIRuntimeToolExecutor,
} from "./tool-executor.js";
import {
  assertRuntimeRequestScoped,
  assertRuntimeResponseSafe,
} from "./policy.js";

export interface PinAIModelAdapter {
  run(
    request: PinAIRuntimeRequest,
    memory: PinAIConversationMemory,
    tools: PinAIRuntimeToolExecutor,
  ): Promise<PinAIRuntimeResponse>;
}

export class GuardedPinAIModelAdapter implements PinAIModelAdapter {
  constructor(
    private readonly delegate: PinAIModelAdapter,
  ) {}

  async run(
    request: PinAIRuntimeRequest,
    memory: PinAIConversationMemory,
    tools: PinAIRuntimeToolExecutor,
  ): Promise<PinAIRuntimeResponse> {
    assertRuntimeRequestScoped(request);

    const response = await this.delegate.run(request, memory, tools);

    assertRuntimeResponseSafe(response);

    return response;
  }
}
