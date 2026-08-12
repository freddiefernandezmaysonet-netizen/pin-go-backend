import {
  readChannexAriDispatchSelection,
  type ReadChannexAriDispatchSelectionInput,
} from "./channex-ari-job-selection.service";
import {
  runSelectedChannexAriBatch,
  type ChannexAriSelectedBatchRunnerDb,
} from "./channex-ari-selected-batch-runner.service";
import type { ChannexAriHttpTransport } from "./channex-ari-http.client";

export type ChannexAriDispatchCycleDb =
  Parameters<typeof readChannexAriDispatchSelection>[0] &
  ChannexAriSelectedBatchRunnerDb;

export type RunChannexAriDispatchCycleInput = {
  db: ChannexAriDispatchCycleDb;
  selection?: ReadChannexAriDispatchSelectionInput;
  credentialsSecret?: string;
  globalApiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  jitterMs?: number;
  leaseMs?: number;
  completionReserveMs?: number;
  transport?: ChannexAriHttpTransport;
  clock?: () => Date;
  leaseTokenFactory?: Parameters<
    typeof runSelectedChannexAriBatch
  >[0]["leaseTokenFactory"];
  readSelection?: typeof readChannexAriDispatchSelection;
  runBatch?: typeof runSelectedChannexAriBatch;
};

function assertSelectionContract(selection: unknown): asserts selection is Awaited<
  ReturnType<typeof readChannexAriDispatchSelection>
> {
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
    throw new Error("CHANNEX_ARI_DISPATCH_CYCLE_SELECTION_INVALID");
  }

  const value = selection as Record<string, unknown>;

  if (!Array.isArray(value.actions)) {
    throw new Error("CHANNEX_ARI_DISPATCH_CYCLE_ACTIONS_INVALID");
  }

  if (
    !Number.isSafeInteger(value.selectedCount) ||
    Number(value.selectedCount) < 0 ||
    Number(value.selectedCount) !== value.actions.length
  ) {
    throw new Error("CHANNEX_ARI_DISPATCH_CYCLE_SELECTED_COUNT_MISMATCH");
  }
}

export async function runChannexAriDispatchCycle(
  input: RunChannexAriDispatchCycleInput
) {
  const readSelection =
    input.readSelection ?? readChannexAriDispatchSelection;
  const runBatch = input.runBatch ?? runSelectedChannexAriBatch;
  const selection = await readSelection(input.db, input.selection ?? {});

  assertSelectionContract(selection);

  const batch = await runBatch({
    db: input.db,
    actions: selection.actions,
    credentialsSecret: input.credentialsSecret,
    globalApiKey: input.globalApiKey,
    baseUrl: input.baseUrl,
    timeoutMs: input.timeoutMs,
    jitterMs: input.jitterMs,
    leaseMs: input.leaseMs,
    completionReserveMs: input.completionReserveMs,
    transport: input.transport,
    clock: input.clock,
    leaseTokenFactory: input.leaseTokenFactory,
  });

  return {
    selection,
    batch,
  };
}
