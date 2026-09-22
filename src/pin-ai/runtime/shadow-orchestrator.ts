import type {
  PinAIRuntimeRequest,
  PinAIRuntimeResponse,
} from "./contracts.js";
import {
  createConversationMemory,
  type PinAIConversationMemory,
} from "./conversation-memory.js";
import type {
  PinAIRuntimeToolExecutor,
} from "./tool-executor.js";
import type {
  PinAIModelAdapter,
} from "./model-adapter.js";

export type PinAIShadowRunResult = Readonly<{
  mode: "SHADOW";
  request: PinAIRuntimeRequest;
  memory: PinAIConversationMemory;
  response: PinAIRuntimeResponse;
  actionsExecuted: false;
}>;

export class PinAIShadowOrchestrator {
  constructor(
    private readonly model: PinAIModelAdapter,
    private readonly tools: PinAIRuntimeToolExecutor,
  ) {}

  async run(request: PinAIRuntimeRequest): Promise<PinAIShadowRunResult> {
    const memory = createConversationMemory(request);
    const response = await this.model.run(request, memory, this.tools);

    return {
      mode: "SHADOW",
      request,
      memory,
      response,
      actionsExecuted: false,
    };
  }
}
