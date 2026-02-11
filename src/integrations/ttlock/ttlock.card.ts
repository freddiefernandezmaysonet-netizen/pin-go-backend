// src/integrations/ttlock/ttlock.card.ts

import { getTTLockClientForOrg } from "./ttlock.auth";

export async function ttlockActivateCard(args: {
  ttlockLockId: number;
  cardId: number;
  start: Date;
  end: Date;
  organizationId: string;
}) {
  const client = await getTTLockClientForOrg(args.organizationId);

  const resp = await client.changeCardPeriod({
    lockId: args.ttlockLockId,
    cardId: args.cardId,
    startDate: args.start.getTime(),
    endDate: args.end.getTime(),
  });

  return (resp as any)?.data ?? resp;
}

export async function ttlockDeactivateCard(args: {
  ttlockLockId: number;
  cardId: number;
  organizationId: string;
}) {
  const client = await getTTLockClientForOrg(args.organizationId);

  const now = Date.now() - 1000;
  const resp = await client.changeCardPeriod({
    lockId: args.ttlockLockId,
    cardId: args.cardId,
    startDate: now,
    endDate: now,
  });

  return (resp as any)?.data ?? resp;
}
