// src/services/billing.entitlement.ts
import { prisma } from "../lib/prisma";

export async function isOrgEntitled(organizationId: string, now = new Date()) {
  const sub = await prisma.subscription.findUnique({
    where: { organizationId },
    select: { status: true, currentPeriodEnd: true, graceUntil: true },
  });

  // Sin suscripción = bloqueado (puedes cambiarlo si quieres "FREE")
  if (!sub) return { ok: false, reason: "NO_SUBSCRIPTION" as const };

  // Estados permitidos
  if (sub.status === "ACTIVE" || sub.status === "TRIALING") {
    return { ok: true, reason: "ENTITLED" as const };
  }

  // Existing rows without a verified grace deadline retain their previous
  // behavior until the next subscription webhook sync; do not backdate them.
  if (sub.status === "PAST_DUE") {
    const deadline = sub.graceUntil ?? sub.currentPeriodEnd;
    const graceOk = !!deadline && deadline.getTime() >= now.getTime();
    return graceOk
      ? { ok: true, reason: "GRACE" as const }
      : { ok: false, reason: "GRACE_EXPIRED" as const };
  }

  // Todo lo demás bloquea
  return { ok: false, reason: `STATUS_${sub.status}` as const };
}
