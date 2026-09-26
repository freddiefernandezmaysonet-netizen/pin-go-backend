import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import {
  PinAIActionProposalStatus,
  PinAIActionProposalType,
  Prisma,
  ReservationStatus,
  type PrismaClient,
} from "@prisma/client";

export const PIN_AI_ACTION_PROPOSAL_VERSION =
  "pin_ai_action_proposal_v1" as const;

export const PIN_AI_ACTION_PROPOSAL_DEFAULT_TTL_MS =
  15 * 60 * 1000;

export const PIN_AI_ACTION_PROPOSAL_MAX_TTL_MS =
  60 * 60 * 1000;

const GUEST_TOKEN_PATTERN =
  /^[A-Za-z0-9_-]{16,200}$/;

const CONFIRMATION_TOKEN_PATTERN =
  /^[A-Za-z0-9_-]{40,128}$/;

type ProposalLanguage = "en" | "es";

type ProposalTerms =
  Readonly<Record<string, unknown>>;

type ProposalReservationScope = Readonly<{
  id: string;
  propertyId: string;
  updatedAt: Date;
  guestTokenExpiresAt: Date | null;
  property: Readonly<{
    organizationId: string;
    status: string;
  }>;
}>;

export class PinAIActionProposalError
  extends Error {
  constructor(
    readonly code:
      | "INVALID_GUEST_TOKEN"
      | "INVALID_ACTION_TYPE"
      | "INVALID_LANGUAGE"
      | "INVALID_CONSENT_TEXT"
      | "INVALID_TERMS"
      | "INVALID_EXPIRY"
      | "INVALID_PROPOSAL_ID"
      | "INVALID_CONFIRMATION_TOKEN"
      | "RESERVATION_NOT_FOUND"
      | "PROPOSAL_NOT_FOUND"
      | "PROPOSAL_SCOPE_MISMATCH"
      | "PROPOSAL_EXPIRED"
      | "PROPOSAL_NOT_CONFIRMABLE"
      | "PROPOSAL_SUPERSEDED"
      | "PROPOSAL_TOKEN_MISMATCH"
      | "PROPOSAL_CONCURRENT_CHANGE",
    readonly statusCode = 409,
  ) {
    super(`PIN_AI_ACTION_PROPOSAL_${code}`);
    this.name = "PinAIActionProposalError";
  }
}

export type CreatePinAIActionProposalInput =
  Readonly<{
    prisma: PrismaClient;
    guestToken: unknown;
    actionType: unknown;
    language: unknown;
    consentText: unknown;
    termsSnapshot: ProposalTerms;
    expiresAt?: Date;
    now?: Date;
  }>;

export type ConfirmPinAIActionProposalInput =
  Readonly<{
    prisma: PrismaClient;
    guestToken: unknown;
    proposalId: unknown;
    confirmationToken: unknown;
    now?: Date;
  }>;

export type CancelPinAIActionProposalInput =
  Readonly<{
    prisma: PrismaClient;
    guestToken: unknown;
    proposalId: unknown;
    now?: Date;
  }>;

function fail(
  code: PinAIActionProposalError["code"],
  statusCode = 409,
): never {
  throw new PinAIActionProposalError(
    code,
    statusCode,
  );
}

function normalizeGuestToken(
  value: unknown,
): string {
  const token =
    typeof value === "string"
      ? value.trim()
      : "";

  if (!GUEST_TOKEN_PATTERN.test(token)) {
    return fail("INVALID_GUEST_TOKEN", 400);
  }

  return token;
}

function normalizeProposalId(
  value: unknown,
): string {
  const proposalId =
    typeof value === "string"
      ? value.trim()
      : "";

  if (
    !proposalId ||
    proposalId.length > 128 ||
    !/^[A-Za-z0-9_-]+$/.test(proposalId)
  ) {
    return fail("INVALID_PROPOSAL_ID", 400);
  }

  return proposalId;
}

function normalizeActionType(
  value: unknown,
): PinAIActionProposalType {
  if (
    value !==
    PinAIActionProposalType
      .RESERVATION_MODIFICATION
  ) {
    return fail("INVALID_ACTION_TYPE", 400);
  }

  return value;
}

function normalizeLanguage(
  value: unknown,
): ProposalLanguage {
  if (value !== "en" && value !== "es") {
    return fail("INVALID_LANGUAGE", 400);
  }

  return value;
}

function normalizeConsentText(
  value: unknown,
): string {
  const text =
    typeof value === "string"
      ? value.trim()
      : "";

  if (
    !text ||
    text.length > 4_000 ||
    /\u0000/.test(text)
  ) {
    return fail(
      "INVALID_CONSENT_TEXT",
      400,
    );
  }

  return text;
}

function normalizeNow(
  value: Date | undefined,
): Date {
  const now = value
    ? new Date(value)
    : new Date();

  if (Number.isNaN(now.getTime())) {
    return fail("INVALID_EXPIRY", 400);
  }

  return now;
}

function normalizeExpiry(
  requested: Date | undefined,
  now: Date,
  guestTokenExpiresAt: Date | null,
): Date {
  const requestedExpiry = requested
    ? new Date(requested)
    : new Date(
        now.getTime() +
          PIN_AI_ACTION_PROPOSAL_DEFAULT_TTL_MS,
      );

  if (
    Number.isNaN(
      requestedExpiry.getTime(),
    )
  ) {
    return fail("INVALID_EXPIRY", 400);
  }

  const maximumExpiry = new Date(
    now.getTime() +
      PIN_AI_ACTION_PROPOSAL_MAX_TTL_MS,
  );

  let expiresAt =
    requestedExpiry < maximumExpiry
      ? requestedExpiry
      : maximumExpiry;

  if (
    guestTokenExpiresAt &&
    guestTokenExpiresAt < expiresAt
  ) {
    expiresAt =
      new Date(guestTokenExpiresAt);
  }

  if (expiresAt <= now) {
    return fail("INVALID_EXPIRY", 400);
  }

  return expiresAt;
}

function canonicalize(
  value: unknown,
): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return fail("INVALID_TERMS", 400);
    }
    return value;
  }

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return fail("INVALID_TERMS", 400);
    }
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (
    value &&
    typeof value === "object"
  ) {
    const entries =
      Object.entries(
        value as Record<
          string,
          unknown
        >,
      ).sort(([left], [right]) =>
        left.localeCompare(right),
      );

    const normalized:
      Record<string, unknown> = {};

    for (const [key, nested] of entries) {
      if (
        !key ||
        key.length > 160 ||
        nested === undefined ||
        typeof nested === "function" ||
        typeof nested === "symbol" ||
        typeof nested === "bigint"
      ) {
        return fail(
          "INVALID_TERMS",
          400,
        );
      }

      normalized[key] =
        canonicalize(nested);
    }

    return normalized;
  }

  return fail("INVALID_TERMS", 400);
}

export function canonicalPinAIActionTerms(
  value: ProposalTerms,
): string {
  const normalized =
    canonicalize(value);

  if (
    !normalized ||
    typeof normalized !== "object" ||
    Array.isArray(normalized)
  ) {
    return fail("INVALID_TERMS", 400);
  }

  return JSON.stringify(normalized);
}

export function buildPinAIActionProposalFingerprint(
  input: Readonly<{
    organizationId: string;
    propertyId: string;
    reservationId: string;
    baseReservationUpdatedAt: Date;
    actionType:
      PinAIActionProposalType;
    language:
      ProposalLanguage;
    consentText: string;
    termsSnapshot:
      ProposalTerms;
  }>,
): string {
  return createHash("sha256")
    .update(
      canonicalPinAIActionTerms({
        version:
          PIN_AI_ACTION_PROPOSAL_VERSION,
        organizationId:
          input.organizationId,
        propertyId:
          input.propertyId,
        reservationId:
          input.reservationId,
        baseReservationUpdatedAt:
          input.baseReservationUpdatedAt
            .toISOString(),
        actionType:
          input.actionType,
        language:
          input.language,
        consentText:
          input.consentText,
        termsSnapshot:
          input.termsSnapshot,
      }),
      "utf8",
    )
    .digest("hex");
}

function deriveConfirmationToken(
  input: Readonly<{
    guestToken: string;
    proposalId: string;
    proposalFingerprint: string;
    expiresAt: Date;
  }>,
): string {
  return createHmac(
    "sha256",
    input.guestToken,
  )
    .update(
      [
        PIN_AI_ACTION_PROPOSAL_VERSION,
        input.proposalId,
        input.proposalFingerprint,
        input.expiresAt.toISOString(),
      ].join(":"),
      "utf8",
    )
    .digest("base64url");
}

function hashConfirmationToken(
  token: string,
): string {
  return createHash("sha256")
    .update(token, "utf8")
    .digest("hex");
}

function tokensMatch(
  presentedToken: string,
  expectedHash: string,
): boolean {
  if (
    !CONFIRMATION_TOKEN_PATTERN.test(
      presentedToken,
    ) ||
    !/^[a-f0-9]{64}$/.test(
      expectedHash,
    )
  ) {
    return false;
  }

  const presentedHash =
    Buffer.from(
      hashConfirmationToken(
        presentedToken,
      ),
      "hex",
    );
  const expected =
    Buffer.from(
      expectedHash,
      "hex",
    );

  return (
    presentedHash.length ===
      expected.length &&
    timingSafeEqual(
      presentedHash,
      expected,
    )
  );
}

function isRetryableTransactionError(
  error: unknown,
): boolean {
  return (
    error instanceof
      Prisma.PrismaClientKnownRequestError &&
    (
      [
        "P2034",
        "P2002",
      ].includes(error.code) ||
      (
        error.code === "P2010" &&
        ["40001", "40P01"].includes(
          String(
            error.meta?.code,
          ),
        )
      )
    )
  );
}

async function lockReservationByGuestToken(
  db: Prisma.TransactionClient,
  guestToken: string,
): Promise<string> {
  const rows =
    await db.$queryRaw<
      Array<{ id: string }>
    >`
      SELECT "id"
      FROM "Reservation"
      WHERE "guestToken" = ${guestToken}
      FOR UPDATE
    `;

  const reservationId =
    rows[0]?.id;

  if (!reservationId) {
    return fail(
      "RESERVATION_NOT_FOUND",
      404,
    );
  }

  return reservationId;
}

async function loadReservationScope(
  db: Prisma.TransactionClient,
  reservationId: string,
  guestToken: string,
  now: Date,
): Promise<ProposalReservationScope> {
  const reservation =
    await db.reservation.findFirst({
      where: {
        id: reservationId,
        guestToken,
        status:
          ReservationStatus.ACTIVE,
        OR: [
          {
            guestTokenExpiresAt:
              null,
          },
          {
            guestTokenExpiresAt: {
              gt: now,
            },
          },
        ],
        property: {
          status: "ACTIVE",
        },
      },
      select: {
        id: true,
        propertyId: true,
        updatedAt: true,
        guestTokenExpiresAt: true,
        property: {
          select: {
            organizationId: true,
            status: true,
          },
        },
      },
    });

  if (!reservation) {
    return fail(
      "RESERVATION_NOT_FOUND",
      404,
    );
  }

  return reservation;
}

function publicProposal(
  proposal: Readonly<{
    id: string;
    actionType:
      PinAIActionProposalType;
    status:
      PinAIActionProposalStatus;
    proposalFingerprint: string;
    baseReservationUpdatedAt: Date;
    language: string;
    consentText: string;
    termsSnapshot: unknown;
    expiresAt: Date;
    confirmedAt: Date | null;
    createdAt: Date;
  }>,
) {
  return {
    id: proposal.id,
    version:
      PIN_AI_ACTION_PROPOSAL_VERSION,
    actionType:
      proposal.actionType,
    status:
      proposal.status,
    proposalFingerprint:
      proposal.proposalFingerprint,
    baseReservationUpdatedAt:
      proposal.baseReservationUpdatedAt,
    language:
      proposal.language,
    consentText:
      proposal.consentText,
    termsSnapshot:
      proposal.termsSnapshot,
    expiresAt:
      proposal.expiresAt,
    confirmedAt:
      proposal.confirmedAt,
    createdAt:
      proposal.createdAt,
  };
}

export async function createPinAIActionProposal(
  input:
    CreatePinAIActionProposalInput,
) {
  const guestToken =
    normalizeGuestToken(
      input.guestToken,
    );
  const actionType =
    normalizeActionType(
      input.actionType,
    );
  const language =
    normalizeLanguage(
      input.language,
    );
  const consentText =
    normalizeConsentText(
      input.consentText,
    );
  const canonicalTerms =
    canonicalPinAIActionTerms(
      input.termsSnapshot,
    );
  const termsSnapshot =
    JSON.parse(
      canonicalTerms,
    ) as Prisma.InputJsonValue;
  const now =
    normalizeNow(input.now);

  for (
    let attempt = 0;
    attempt < 3;
    attempt += 1
  ) {
    try {
      return await input.prisma
        .$transaction(
          async (db) => {
            const reservationId =
              await lockReservationByGuestToken(
                db,
                guestToken,
              );
            const reservation =
              await loadReservationScope(
                db,
                reservationId,
                guestToken,
                now,
              );
            const expiresAt =
              normalizeExpiry(
                input.expiresAt,
                now,
                reservation
                  .guestTokenExpiresAt,
              );
            const fingerprint =
              buildPinAIActionProposalFingerprint({
                organizationId:
                  reservation.property
                    .organizationId,
                propertyId:
                  reservation.propertyId,
                reservationId:
                  reservation.id,
                baseReservationUpdatedAt:
                  reservation.updatedAt,
                actionType,
                language,
                consentText,
                termsSnapshot:
                  input.termsSnapshot,
              });

            await db
              .pinAIActionProposal
              .updateMany({
                where: {
                  reservationId:
                    reservation.id,
                  actionType,
                  status:
                    PinAIActionProposalStatus
                      .PENDING_CONFIRMATION,
                  expiresAt: {
                    lte: now,
                  },
                },
                data: {
                  status:
                    PinAIActionProposalStatus
                      .EXPIRED,
                },
              });

            const existing =
              await db
                .pinAIActionProposal
                .findFirst({
                  where: {
                    reservationId:
                      reservation.id,
                    actionType,
                    status:
                      PinAIActionProposalStatus
                        .PENDING_CONFIRMATION,
                    proposalFingerprint:
                      fingerprint,
                    expiresAt: {
                      gt: now,
                    },
                  },
                  orderBy: {
                    createdAt:
                      "desc",
                  },
                });

            if (existing) {
              const token =
                deriveConfirmationToken({
                  guestToken,
                  proposalId:
                    existing.id,
                  proposalFingerprint:
                    existing
                      .proposalFingerprint,
                  expiresAt:
                    existing.expiresAt,
                });

              if (
                hashConfirmationToken(
                  token,
                ) !==
                existing
                  .confirmationTokenHash
              ) {
                return fail(
                  "PROPOSAL_TOKEN_MISMATCH",
                );
              }

              return {
                ok: true,
                idempotentReplay:
                  true,
                actionExecuted:
                  false as const,
                confirmationToken:
                  token,
                proposal:
                  publicProposal(
                    existing,
                  ),
              };
            }

            await db
              .pinAIActionProposal
              .updateMany({
                where: {
                  reservationId:
                    reservation.id,
                  actionType,
                  status:
                    PinAIActionProposalStatus
                      .PENDING_CONFIRMATION,
                },
                data: {
                  status:
                    PinAIActionProposalStatus
                      .SUPERSEDED,
                  supersededAt:
                    now,
                },
              });

            const proposalId =
              randomUUID();
            const token =
              deriveConfirmationToken({
                guestToken,
                proposalId,
                proposalFingerprint:
                  fingerprint,
                expiresAt,
              });
            const tokenHash =
              hashConfirmationToken(
                token,
              );

            const proposal =
              await db
                .pinAIActionProposal
                .create({
                  data: {
                    id: proposalId,
                    organizationId:
                      reservation
                        .property
                        .organizationId,
                    propertyId:
                      reservation
                        .propertyId,
                    reservationId:
                      reservation.id,
                    version:
                      PIN_AI_ACTION_PROPOSAL_VERSION,
                    actionType,
                    status:
                      PinAIActionProposalStatus
                        .PENDING_CONFIRMATION,
                    proposalFingerprint:
                      fingerprint,
                    baseReservationUpdatedAt:
                      reservation
                        .updatedAt,
                    language,
                    consentText,
                    termsSnapshot,
                    confirmationTokenHash:
                      tokenHash,
                    expiresAt,
                    createdAt:
                      now,
                  },
                });

            return {
              ok: true,
              idempotentReplay:
                false,
              actionExecuted:
                false as const,
              confirmationToken:
                token,
              proposal:
                publicProposal(
                  proposal,
                ),
            };
          },
          {
            isolationLevel:
              Prisma
                .TransactionIsolationLevel
                .Serializable,
          },
        );
    } catch (error) {
      if (
        isRetryableTransactionError(
          error,
        ) &&
        attempt < 2
      ) {
        continue;
      }

      if (
        isRetryableTransactionError(
          error,
        )
      ) {
        return fail(
          "PROPOSAL_CONCURRENT_CHANGE",
        );
      }

      throw error;
    }
  }

  return fail(
    "PROPOSAL_CONCURRENT_CHANGE",
  );
}

export async function confirmPinAIActionProposal(
  input:
    ConfirmPinAIActionProposalInput,
) {
  const guestToken =
    normalizeGuestToken(
      input.guestToken,
    );
  const proposalId =
    normalizeProposalId(
      input.proposalId,
    );
  const confirmationToken =
    typeof input.confirmationToken ===
      "string"
      ? input.confirmationToken.trim()
      : "";
  if (
    !CONFIRMATION_TOKEN_PATTERN.test(
      confirmationToken,
    )
  ) {
    return fail(
      "INVALID_CONFIRMATION_TOKEN",
      400,
    );
  }
  const now =
    normalizeNow(input.now);

  for (
    let attempt = 0;
    attempt < 3;
    attempt += 1
  ) {
    try {
      const transactionResult =
        await input.prisma
          .$transaction(
          async (db) => {
            const reservationId =
              await lockReservationByGuestToken(
                db,
                guestToken,
              );
            const reservation =
              await loadReservationScope(
                db,
                reservationId,
                guestToken,
                now,
              );

            await db.$queryRaw`
              SELECT "id"
              FROM "PinAIActionProposal"
              WHERE "id" = ${proposalId}
              FOR UPDATE
            `;

            let proposal =
              await db
                .pinAIActionProposal
                .findUnique({
                  where: {
                    id: proposalId,
                  },
                });

            if (!proposal) {
              return fail(
                "PROPOSAL_NOT_FOUND",
                404,
              );
            }

            if (
              proposal.reservationId !==
                reservation.id ||
              proposal.propertyId !==
                reservation.propertyId ||
              proposal.organizationId !==
                reservation.property
                  .organizationId
            ) {
              return fail(
                "PROPOSAL_SCOPE_MISMATCH",
                404,
              );
            }

            if (
              !tokensMatch(
                confirmationToken,
                proposal
                  .confirmationTokenHash,
              )
            ) {
              return fail(
                "PROPOSAL_TOKEN_MISMATCH",
                403,
              );
            }

            if (
              proposal.status ===
              PinAIActionProposalStatus
                .CONFIRMED
            ) {
              return {
                ok: true,
                idempotentReplay:
                  true,
                proposalConfirmed:
                  true as const,
                actionExecuted:
                  false as const,
                proposal:
                  publicProposal(
                    proposal,
                  ),
              };
            }

            if (
              proposal.status !==
              PinAIActionProposalStatus
                .PENDING_CONFIRMATION
            ) {
              return fail(
                "PROPOSAL_NOT_CONFIRMABLE",
              );
            }

            if (
              proposal.expiresAt <= now
            ) {
              await db
                .pinAIActionProposal
                .update({
                  where: {
                    id: proposal.id,
                  },
                  data: {
                    status:
                      PinAIActionProposalStatus
                        .EXPIRED,
                  },
                });
              return {
                deferredError: {
                  code:
                    "PROPOSAL_EXPIRED" as const,
                  statusCode: 410,
                },
              };
            }

            if (
              proposal
                .baseReservationUpdatedAt
                .getTime() !==
              reservation.updatedAt
                .getTime()
            ) {
              await db
                .pinAIActionProposal
                .update({
                  where: {
                    id: proposal.id,
                  },
                  data: {
                    status:
                      PinAIActionProposalStatus
                        .SUPERSEDED,
                    supersededAt:
                      now,
                  },
                });
              return {
                deferredError: {
                  code:
                    "PROPOSAL_SUPERSEDED" as const,
                  statusCode: 409,
                },
              };
            }

            const updated =
              await db
                .pinAIActionProposal
                .updateMany({
                  where: {
                    id:
                      proposal.id,
                    status:
                      PinAIActionProposalStatus
                        .PENDING_CONFIRMATION,
                    baseReservationUpdatedAt:
                      reservation
                        .updatedAt,
                    expiresAt: {
                      gt: now,
                    },
                  },
                  data: {
                    status:
                      PinAIActionProposalStatus
                        .CONFIRMED,
                    confirmedAt:
                      now,
                  },
                });

            if (
              updated.count !== 1
            ) {
              return fail(
                "PROPOSAL_CONCURRENT_CHANGE",
              );
            }

            proposal =
              await db
                .pinAIActionProposal
                .findUniqueOrThrow({
                  where: {
                    id: proposal.id,
                  },
                });

            return {
              ok: true,
              idempotentReplay:
                false,
              proposalConfirmed:
                true as const,
              actionExecuted:
                false as const,
              proposal:
                publicProposal(
                  proposal,
                ),
            };
          },
          {
            isolationLevel:
              Prisma
                .TransactionIsolationLevel
                .Serializable,
          },
        );

      const deferredError =
        "deferredError" in
          transactionResult
          ? transactionResult
              .deferredError
          : undefined;

      if (deferredError) {
        return fail(
          deferredError.code,
          deferredError.statusCode,
        );
      }

      return transactionResult;
    } catch (error) {
      if (
        isRetryableTransactionError(
          error,
        ) &&
        attempt < 2
      ) {
        continue;
      }

      if (
        isRetryableTransactionError(
          error,
        )
      ) {
        return fail(
          "PROPOSAL_CONCURRENT_CHANGE",
        );
      }

      throw error;
    }
  }

  return fail(
    "PROPOSAL_CONCURRENT_CHANGE",
  );
}

export async function cancelPinAIActionProposal(
  input:
    CancelPinAIActionProposalInput,
) {
  const guestToken =
    normalizeGuestToken(
      input.guestToken,
    );
  const proposalId =
    normalizeProposalId(
      input.proposalId,
    );
  const now =
    normalizeNow(input.now);

  return input.prisma
    .$transaction(
      async (db) => {
        const reservationId =
          await lockReservationByGuestToken(
            db,
            guestToken,
          );
        const reservation =
          await loadReservationScope(
            db,
            reservationId,
            guestToken,
            now,
          );

        const proposal =
          await db
            .pinAIActionProposal
            .findUnique({
              where: {
                id: proposalId,
              },
            });

        if (!proposal) {
          return fail(
            "PROPOSAL_NOT_FOUND",
            404,
          );
        }

        if (
          proposal.reservationId !==
            reservation.id ||
          proposal.propertyId !==
            reservation.propertyId ||
          proposal.organizationId !==
            reservation.property
              .organizationId
        ) {
          return fail(
            "PROPOSAL_SCOPE_MISMATCH",
            404,
          );
        }

        if (
          proposal.status ===
          PinAIActionProposalStatus
            .CANCELLED
        ) {
          return {
            ok: true,
            idempotentReplay:
              true,
            actionExecuted:
              false as const,
            proposal:
              publicProposal(
                proposal,
              ),
          };
        }

        if (
          proposal.status !==
          PinAIActionProposalStatus
            .PENDING_CONFIRMATION
        ) {
          return fail(
            "PROPOSAL_NOT_CONFIRMABLE",
          );
        }

        const cancelled =
          await db
            .pinAIActionProposal
            .update({
              where: {
                id: proposal.id,
              },
              data: {
                status:
                  PinAIActionProposalStatus
                    .CANCELLED,
                cancelledAt:
                  now,
              },
            });

        return {
          ok: true,
          idempotentReplay:
            false,
          actionExecuted:
            false as const,
          proposal:
            publicProposal(
              cancelled,
            ),
        };
      },
      {
        isolationLevel:
          Prisma
            .TransactionIsolationLevel
            .Serializable,
      },
    );
}
