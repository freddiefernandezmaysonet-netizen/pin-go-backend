import { prisma } from "../../lib/prisma.js";
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
