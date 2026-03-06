// src/services/nfc-autoheal.service.ts
import { PrismaClient } from "@prisma/client";
import { assignNfcCards } from "./nfc.service";

const prisma = new PrismaClient();

/**
 * Auto-heal por assignmentId.
 * Principio: no romper nada; re-intentar el flujo existente (assignNfcCards).
 */
export async function healNfcAssignment(assignmentId: string) {
  const a = await prisma.nfcAssignment.findUnique({
    where: { id: assignmentId },
    include: {
      NfcCard: true,
      Reservation: true,
    },
  });

  if (!a) return;

  // Si ya está expirado/terminado, no tocar (ajusta si tienes otros estados finales)
  // if (a.status === NfcAssignmentStatus.ENDED) return;

  // Reutiliza tu lógica real (idempotente idealmente)
  // Si assignNfcCards requiere prisma como 1er arg, usa la línea A.
  // Si NO lo requiere, usa la línea B.

  // A) ✅ más probable en tu codebase:
  throw new Error("healNfcAssignment is not wired: assignNfcCards requires reservation/lock params.");

  // B) (si te da error de argumentos, cambia a esta):
  // await assignNfcCards({ assignmentId: a.id });
}
