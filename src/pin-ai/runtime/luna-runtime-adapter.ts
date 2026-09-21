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
import type {
  PinAIModelAdapter,
} from "./model-adapter.js";
import {
  OpenAIAgentsRuntimeTransport,
} from "./openai-agents-runtime-transport.js";

export class LunaRuntimeAdapter implements PinAIModelAdapter {
  constructor(
    private readonly transport: OpenAIAgentsRuntimeTransport,
  ) {}

  async run(
    request: PinAIRuntimeRequest,
    memory: PinAIConversationMemory,
    tools: PinAIRuntimeToolExecutor,
  ): Promise<PinAIRuntimeResponse> {
    return this.transport.run(request, memory, tools);
  }
}
