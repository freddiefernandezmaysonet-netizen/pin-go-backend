import { prisma } from "../../lib/prisma.js";
import {
  PinAIActionProposalRuntimeToolExecutor,
  type PinAIActionProposalRuntimeToolDependencies,
} from "./action-proposal-tool-executor.js";
import {
  GuardedPinAIRuntimeToolExecutor,
  type PinAIRuntimeToolExecutor,
} from "./tool-executor.js";
import {
  PinGoRuntimeReadToolExecutor,
} from "./pin-go-read-tool-executor.js";

export function createPinGoRuntimeReadToolExecutor(): PinAIRuntimeToolExecutor {
  return new GuardedPinAIRuntimeToolExecutor(
    new PinGoRuntimeReadToolExecutor(prisma),
  );
}

export function createPinGoRuntimeToolExecutorWithActionProposal(
  input: Omit<
    PinAIActionProposalRuntimeToolDependencies,
    "delegate"
  >,
): Readonly<{
  executor:
    PinAIRuntimeToolExecutor;
  actionProposalExecutor:
    PinAIActionProposalRuntimeToolExecutor;
}> {
  const actionProposalExecutor =
    new PinAIActionProposalRuntimeToolExecutor({
      ...input,
      delegate:
        new PinGoRuntimeReadToolExecutor(
          prisma,
        ),
    });

  return {
    executor:
      new GuardedPinAIRuntimeToolExecutor(
        actionProposalExecutor,
      ),
    actionProposalExecutor,
  };
}
