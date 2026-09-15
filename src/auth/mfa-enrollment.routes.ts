import { randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import { PrismaClient } from "@prisma/client";
import { extractTokenFromRequest, verifyAuthToken } from "../lib/auth";
import { prepareEnrollment } from "./mfa-enrollment";
import { maskOtpDestination, type OtpFactorType } from "./mfa-otp";

const prisma = new PrismaClient();
export const mfaEnrollmentRouter = Router();

async function requireCurrentUser(req: Request) {
  const token = extractTokenFromRequest(req);
  if (!token) return null;
  try {
    const payload: any = verifyAuthToken(token);
    const user = await prisma.dashboardUser.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, organizationId: true, isActive: true, tokenVersion: true },
    });
    if (!user || !user.isActive || user.tokenVersion !== payload.tokenVersion) return null;
    return user;
  } catch {
    return null;
  }
}

mfaEnrollmentRouter.get("/auth/mfa/factors", async (req, res) => {
  const user = await requireCurrentUser(req);
  if (!user) return res.status(401).json({ error: "UNAUTHENTICATED" });
  try {
    const rows = await prisma.$queryRaw<Array<{ id: string; type: OtpFactorType; destination: string; status: "PENDING" | "VERIFIED" | "DISABLED"; verifiedAt: Date | null }>>`
      SELECT "id", "type", "destination", "status", "verifiedAt"
      FROM "AuthFactor"
      WHERE "userId" = ${user.id}
        AND "type" IN ('EMAIL'::"AuthFactorType", 'SMS'::"AuthFactorType")
      ORDER BY "createdAt" ASC
    `;
    return res.json({
      factors: rows.map((factor) => ({
        id: factor.id,
        type: factor.type,
        destinationMasked: maskOtpDestination(factor.type, factor.destination),
        status: factor.status,
        verifiedAt: factor.verifiedAt,
      })),
    });
  } catch (error) {
    console.error("[auth/mfa/factors] E3 persistence unavailable", error);
    return res.status(503).json({ error: "MFA_PERSISTENCE_UNAVAILABLE" });
  }
});

mfaEnrollmentRouter.post("/auth/mfa/enrollment", async (req, res) => {
  const user = await requireCurrentUser(req);
  if (!user) return res.status(401).json({ error: "UNAUTHENTICATED" });

  const type = String(req.body?.type ?? "").trim().toUpperCase() as OtpFactorType;
  if (type !== "EMAIL" && type !== "SMS") return res.status(400).json({ error: "MFA_FACTOR_TYPE_UNSUPPORTED" });

  try {
    const factor = prepareEnrollment({
      userId: user.id,
      accountEmail: user.email,
      type,
      destination: req.body?.destination,
    });
    const id = randomUUID();
    await prisma.$executeRaw`
      INSERT INTO "AuthFactor" ("id", "userId", "type", "status", "destination", "createdAt", "updatedAt")
      VALUES (${id}, ${user.id}, ${factor.type}::"AuthFactorType", 'PENDING'::"AuthFactorStatus", ${factor.destination}, NOW(), NOW())
      ON CONFLICT ("userId", "type", "destination")
      DO UPDATE SET "updatedAt" = NOW()
    `;

    return res.status(201).json({
      ok: true,
      factor: {
        type: factor.type,
        destinationMasked: maskOtpDestination(factor.type, factor.destination),
        status: "PENDING",
      },
      verification: "DEFERRED_TO_E4_REAL_DELIVERY",
    });
  } catch (error: any) {
    const message = String(error?.message ?? "");
    if (message.includes("EMAIL_MUST_MATCH_ACCOUNT") || message.includes("INVALID_") || message.includes("SMS_DESTINATION_REQUIRED")) {
      return res.status(400).json({ error: message });
    }
    console.error("[auth/mfa/enrollment] E3 enrollment failed", error);
    return res.status(503).json({ error: "MFA_ENROLLMENT_UNAVAILABLE" });
  }
});
