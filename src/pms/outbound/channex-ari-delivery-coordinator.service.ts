import type { ChannexAriAttemptCompletionDb } from "./channex-ari-attempt-completion.service";
import {
  resolveChannexAriCredentials,
  type ChannexAriCredentialsDb,
} from "./channex-ari-credentials.service";
import {
  executeClaimedChannexAriDelivery,
  type ClaimedChannexAriDelivery,
} from "./channex-ari-delivery-executor.service";
import type { ChannexAriHttpTransport } from "./channex-ari-http.client";

export type ChannexAriDeliveryCoordinatorDb =
  ChannexAriCredentialsDb & ChannexAriAttemptCompletionDb;

export type CoordinateClaimedChannexAriDeliveryInput = {
  db: ChannexAriDeliveryCoordinatorDb;
  delivery: ClaimedChannexAriDelivery;
  credentialsSecret?: string;
  globalApiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  jitterMs?: number;
  completionReserveMs?: number;
  transport?: ChannexAriHttpTransport;
  clock?: () => Date;
  resolveCredentials?: typeof resolveChannexAriCredentials;
  execute?: typeof executeClaimedChannexAriDelivery;
};

export async function coordinateClaimedChannexAriDelivery(
  input: CoordinateClaimedChannexAriDeliveryInput
) {
  const resolveCredentials =
    input.resolveCredentials ?? resolveChannexAriCredentials;
  const execute = input.execute ?? executeClaimedChannexAriDelivery;

  const credentials = await resolveCredentials(input.db, {
    connectionId: input.delivery.connectionId,
    organizationId: input.delivery.organizationId,
    credentialsSecret: input.credentialsSecret,
    globalApiKey: input.globalApiKey,
  });

  const execution = await execute({
    db: input.db,
    delivery: input.delivery,
    apiKey: credentials.apiKey,
    baseUrl: input.baseUrl,
    timeoutMs: input.timeoutMs,
    jitterMs: input.jitterMs,
    completionReserveMs: input.completionReserveMs,
    transport: input.transport,
    clock: input.clock,
  });

  return {
    credentials: credentials.evidence,
    execution,
  };
}
