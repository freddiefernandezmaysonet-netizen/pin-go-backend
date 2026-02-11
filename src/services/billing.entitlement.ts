// src/services/billing.entitlement.ts
import { prisma } from "../lib/prisma";

export async function isOrgEntitled(organizationId: string, now = new Date()) {
  const sub = await prisma.subscription.findUnique({
    where: { organizationId },
    // ✅ graceUntil ya no existe en el schema actual
    // ✅ usamos currentPeriodEnd como fallback de "grace"
    select: { status: true, currentPeriodEnd: true },
  });

  // Sin suscripción = bloqueado (puedes cambiarlo si quieres "FREE")
  if (!sub) return { ok: false, reason: "NO_SUBSCRIPTION" as const };

  // Estados permitidos
  if (sub.status === "ACTIVE" || sub.status === "TRIALING") {
    return { ok: true, reason: "ENTITLED" as const };
  }

  // PAST_DUE: sin graceUntil, permitimos solo si aún no ha pasado el periodEnd
  // (fallback seguro para no romper el worker)
  if (sub.status === "PAST_DUE") {
    const graceOk = !!sub.currentPeriodEnd && sub.currentPeriodEnd.getTime() >= now.getTime();
    return graceOk
      ? { ok: true, reason: "GRACE" as const }
      : { ok: false, reason: "GRACE_EXPIRED" as const };
  }

  // Todo lo demás bloquea
  return { ok: false, reason: `STATUS_${sub.status}` as const };
}
