import assert from "node:assert/strict";
import test from "node:test";

import {
  PinAIActionProposalStatus,
  PinAIActionProposalType,
  ReservationStatus,
  type PrismaClient,
} from "@prisma/client";

import {
  buildPinAIActionProposalFingerprint,
  cancelPinAIActionProposal,
  canonicalPinAIActionTerms,
  confirmPinAIActionProposal,
  createPinAIActionProposal,
  PinAIActionProposalError,
  supersedePinAIActionProposal,
} from "./action-proposal.service.js";

const NOW =
  new Date("2026-09-26T03:30:00.000Z");
const UPDATED_AT =
  new Date("2026-09-26T03:00:00.000Z");
const TOKEN_A =
  "12345678-1234-1234-1234-123456789abc";
const TOKEN_B =
  "87654321-4321-4321-4321-cba987654321";

type ReservationFixture = {
  id: string;
  guestToken: string;
  propertyId: string;
  status: ReservationStatus;
  updatedAt: Date;
  guestTokenExpiresAt: Date | null;
  property: {
    organizationId: string;
    status: string;
  };
};

type ProposalFixture = {
  id: string;
  organizationId: string;
  propertyId: string;
  reservationId: string;
  version: string;
  actionType:
    PinAIActionProposalType;
  status:
    PinAIActionProposalStatus;
  proposalFingerprint: string;
  baseReservationUpdatedAt: Date;
  language: string;
  consentText: string;
  termsSnapshot: unknown;
  confirmationTokenHash: string;
  expiresAt: Date;
  confirmedAt: Date | null;
  cancelledAt: Date | null;
  supersededAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function reservation(
  overrides:
    Partial<ReservationFixture> = {},
): ReservationFixture {
  return {
    id:
      overrides.id ??
      "reservation-a",
    guestToken:
      overrides.guestToken ??
      TOKEN_A,
    propertyId:
      overrides.propertyId ??
      "property-a",
    status:
      overrides.status ??
      ReservationStatus.ACTIVE,
    updatedAt:
      overrides.updatedAt ??
      new Date(UPDATED_AT),
    guestTokenExpiresAt:
      overrides.guestTokenExpiresAt ??
      new Date(
        NOW.getTime() +
          2 * 60 * 60 * 1000,
      ),
    property:
      overrides.property ?? {
        organizationId:
          "organization-a",
        status: "ACTIVE",
      },
  };
}

function terms(
  overrides:
    Record<string, unknown> = {},
) {
  return {
    currentCheckIn:
      "2026-10-01T20:00:00.000Z",
    currentCheckOut:
      "2026-10-04T15:00:00.000Z",
    proposedCheckIn:
      "2026-10-01T20:00:00.000Z",
    proposedCheckOut:
      "2026-10-05T15:00:00.000Z",
    currentTotalAmount:
      353.35,
    proposedTotalAmount:
      521.85,
    amountDifference:
      168.5,
    currency: "usd",
    adults: 2,
    children: 0,
    selectedAmenityIds: [],
    financialAction:
      "ADDITIONAL_PAYMENT_REQUIRED",
    ...overrides,
  };
}

function createPrisma(
  reservations:
    ReservationFixture[] = [
      reservation(),
    ],
) {
  const proposalRecords:
    ProposalFixture[] = [];
  const calls: string[] = [];

  function findReservation(
    args: any,
  ) {
    const where = args?.where ?? {};
    return reservations.find(
      (candidate) => {
        if (
          where.id &&
          candidate.id !== where.id
        ) {
          return false;
        }
        if (
          where.guestToken &&
          candidate.guestToken !==
            where.guestToken
        ) {
          return false;
        }
        if (
          where.status &&
          candidate.status !==
            where.status
        ) {
          return false;
        }
        if (
          where.property?.status &&
          candidate.property.status !==
            where.property.status
        ) {
          return false;
        }

        const expiry =
          where.OR as
            | Array<any>
            | undefined;
        if (expiry) {
          const valid =
            candidate
              .guestTokenExpiresAt ===
              null ||
            candidate
              .guestTokenExpiresAt! >
              NOW;
          if (!valid) return false;
        }

        return true;
      },
    );
  }

  function matchesProposal(
    proposal:
      ProposalFixture,
    where: any,
  ) {
    if (
      where.id &&
      proposal.id !== where.id
    ) {
      return false;
    }
    if (
      where.reservationId &&
      proposal.reservationId !==
        where.reservationId
    ) {
      return false;
    }
    if (
      where.actionType &&
      proposal.actionType !==
        where.actionType
    ) {
      return false;
    }
    if (
      where.status &&
      proposal.status !==
        where.status
    ) {
      return false;
    }
    if (
      where.proposalFingerprint &&
      proposal.proposalFingerprint !==
        where.proposalFingerprint
    ) {
      return false;
    }
    if (
      where.baseReservationUpdatedAt &&
      proposal
        .baseReservationUpdatedAt
        .getTime() !==
        new Date(
          where.baseReservationUpdatedAt,
        ).getTime()
    ) {
      return false;
    }
    if (
      where.expiresAt?.lte &&
      !(
        proposal.expiresAt <=
        where.expiresAt.lte
      )
    ) {
      return false;
    }
    if (
      where.expiresAt?.gt &&
      !(
        proposal.expiresAt >
        where.expiresAt.gt
      )
    ) {
      return false;
    }
    return true;
  }

  const db = {
    async $queryRaw(
      strings:
        TemplateStringsArray,
      ...values: unknown[]
    ) {
      const query =
        strings.join("?");

      if (
        query.includes(
          'FROM "Reservation"',
        )
      ) {
        calls.push(
          "LOCK_RESERVATION",
        );
        const locator =
          String(values[0] ?? "");
        const row =
          reservations.find(
            (item) =>
              item.guestToken ===
                locator ||
              item.id === locator,
          );
        return row
          ? [{ id: row.id }]
          : [];
      }

      if (
        query.includes(
          'FROM "PinAIActionProposal"',
        )
      ) {
        calls.push(
          "LOCK_PROPOSAL",
        );
        const id =
          String(values[0] ?? "");
        const row =
          proposalRecords.find(
            (item) =>
              item.id === id,
          );
        return row
          ? [{ id: row.id }]
          : [];
      }

      throw new Error(
        "UNEXPECTED_RAW_QUERY",
      );
    },

    reservation: {
      async findFirst(
        args: unknown,
      ) {
        calls.push(
          "READ_RESERVATION",
        );
        return (
          findReservation(args) ??
          null
        );
      },
    },

    pinAIActionProposal: {
      async updateMany(
        args: any,
      ) {
        calls.push(
          "UPDATE_MANY_PROPOSAL",
        );
        let count = 0;

        for (
          const proposal of
          proposalRecords
        ) {
          if (
            !matchesProposal(
              proposal,
              args.where ?? {},
            )
          ) {
            continue;
          }

          Object.assign(
            proposal,
            args.data,
            {
              updatedAt:
                new Date(NOW),
            },
          );
          count += 1;
        }

        return { count };
      },

      async findFirst(
        args: any,
      ) {
        calls.push(
          "FIND_PROPOSAL",
        );
        const found =
          proposalRecords
            .filter((item) =>
              matchesProposal(
                item,
                args.where ?? {},
              ),
            )
            .sort(
              (left, right) =>
                right.createdAt
                  .getTime() -
                left.createdAt
                  .getTime(),
            )[0];

        return found ?? null;
      },

      async create(
        args: any,
      ) {
        calls.push(
          "CREATE_PROPOSAL",
        );
        const created:
          ProposalFixture = {
          ...args.data,
          confirmedAt:
            args.data
              .confirmedAt ??
            null,
          cancelledAt:
            args.data
              .cancelledAt ??
            null,
          supersededAt:
            args.data
              .supersededAt ??
            null,
          createdAt:
            args.data.createdAt
              ? new Date(
                  args.data
                    .createdAt,
                )
              : new Date(NOW),
          updatedAt:
            new Date(NOW),
        };

        if (
          proposalRecords.some(
            (item) =>
              item
                .confirmationTokenHash ===
              created
                .confirmationTokenHash,
          )
        ) {
          throw new Error(
            "UNIQUE_TOKEN_HASH",
          );
        }

        if (
          proposalRecords.some(
            (item) =>
              item.reservationId ===
                created
                  .reservationId &&
              item.actionType ===
                created.actionType &&
              item.status ===
                PinAIActionProposalStatus
                  .PENDING_CONFIRMATION,
          )
        ) {
          throw new Error(
            "UNIQUE_PENDING_PROPOSAL",
          );
        }

        proposalRecords.push(
          created,
        );
        return created;
      },

      async findUnique(
        args: any,
      ) {
        calls.push(
          "FIND_UNIQUE_PROPOSAL",
        );
        return (
          proposalRecords.find(
            (item) =>
              item.id ===
              args.where.id,
          ) ?? null
        );
      },

      async findUniqueOrThrow(
        args: any,
      ) {
        const found =
          proposalRecords.find(
            (item) =>
              item.id ===
              args.where.id,
          );
        if (!found) {
          throw new Error(
            "PROPOSAL_NOT_FOUND",
          );
        }
        return found;
      },

      async update(
        args: any,
      ) {
        calls.push(
          "UPDATE_PROPOSAL",
        );
        const found =
          proposalRecords.find(
            (item) =>
              item.id ===
              args.where.id,
          );
        if (!found) {
          throw new Error(
            "PROPOSAL_NOT_FOUND",
          );
        }
        Object.assign(
          found,
          args.data,
          {
            updatedAt:
              new Date(NOW),
          },
        );
        return found;
      },
    },
  };

  const prisma = {
    ...db,
    async $transaction(
      callback:
        (tx: typeof db) =>
          Promise<unknown>,
    ) {
      calls.push(
        "TRANSACTION",
      );
      return callback(db);
    },
  } as unknown as PrismaClient;

  return {
    prisma,
    reservations,
    proposals:
      proposalRecords,
    calls,
  };
}

async function createProposal(
  fixture:
    ReturnType<
      typeof createPrisma
    >,
  overrides:
    Partial<{
      guestToken: string;
      language: "en" | "es";
      consentText: string;
      termsSnapshot:
        Record<string, unknown>;
      expiresAt: Date;
    }> = {},
) {
  return createPinAIActionProposal({
    prisma: fixture.prisma,
    guestToken:
      overrides.guestToken ??
      TOKEN_A,
    actionType:
      PinAIActionProposalType
        .RESERVATION_MODIFICATION,
    language:
      overrides.language ??
      "en",
    consentText:
      overrides.consentText ??
      "I confirm the exact reservation modification shown here.",
    termsSnapshot:
      overrides.termsSnapshot ??
      terms(),
    expiresAt:
      overrides.expiresAt,
    now: NOW,
  });
}

test(
  "canonical terms and fingerprint are deterministic but bind exact consent",
  () => {
    assert.equal(
      canonicalPinAIActionTerms({
        z: 3,
        a: {
          y: 2,
          x: 1,
        },
      }),
      '{"a":{"x":1,"y":2},"z":3}',
    );

    const base = {
      organizationId:
        "organization-a",
      propertyId:
        "property-a",
      reservationId:
        "reservation-a",
      baseReservationUpdatedAt:
        UPDATED_AT,
      actionType:
        PinAIActionProposalType
          .RESERVATION_MODIFICATION,
      language: "en" as const,
      consentText:
        "I accept these terms.",
      termsSnapshot:
        terms(),
    };

    const first =
      buildPinAIActionProposalFingerprint(
        base,
      );
    const reorderedTerms =
      Object.fromEntries(
        Object.entries(
          terms(),
        ).reverse(),
      );

    const reordered =
      buildPinAIActionProposalFingerprint({
        ...base,
        termsSnapshot:
          reorderedTerms,
      });
    const spanish =
      buildPinAIActionProposalFingerprint({
        ...base,
        language: "es",
      });
    const changedConsent =
      buildPinAIActionProposalFingerprint({
        ...base,
        consentText:
          "Different terms.",
      });

    assert.match(
      first,
      /^[a-f0-9]{64}$/,
    );
    assert.equal(
      first,
      reordered,
    );
    assert.notEqual(
      first,
      spanish,
    );
    assert.notEqual(
      first,
      changedConsent,
    );
  },
);

test(
  "create is idempotent in proposal identity and rotates the confirmation token",
  async () => {
    const fixture =
      createPrisma();

    const first =
      await createProposal(
        fixture,
      );
    const replay =
      await createProposal(
        fixture,
      );

    assert.equal(
      fixture.proposals.length,
      1,
    );
    assert.equal(
      first.idempotentReplay,
      false,
    );
    assert.equal(
      replay.idempotentReplay,
      true,
    );
    assert.equal(
      replay.proposal.id,
      first.proposal.id,
    );
    assert.notEqual(
      replay.confirmationToken,
      first.confirmationToken,
    );
    assert.match(
      replay.confirmationToken,
      /^[A-Za-z0-9_-]{43}$/,
    );
    assert.equal(
      replay.actionExecuted,
      false,
    );

    await assert.rejects(
      () =>
        confirmPinAIActionProposal({
          prisma:
            fixture.prisma,
          guestToken:
            TOKEN_A,
          proposalId:
            replay.proposal.id,
          confirmationToken:
            first.confirmationToken,
          now: NOW,
        }),
      (error: unknown) =>
        error instanceof
          PinAIActionProposalError &&
        error.code ===
          "PROPOSAL_TOKEN_MISMATCH",
    );

    const confirmed =
      await confirmPinAIActionProposal({
        prisma:
          fixture.prisma,
        guestToken:
          TOKEN_A,
        proposalId:
          replay.proposal.id,
        confirmationToken:
          replay.confirmationToken,
        now: NOW,
      });

    assert.equal(
      confirmed.proposalConfirmed,
      true,
    );
    assert.equal(
      confirmed.actionExecuted,
      false,
    );
  },
);

test(
  "a different proposal supersedes the older pending proposal",
  async () => {
    const fixture =
      createPrisma();

    const first =
      await createProposal(
        fixture,
      );
    const second =
      await createProposal(
        fixture,
        {
          termsSnapshot:
            terms({
              amountDifference:
                181.2,
              proposedTotalAmount:
                534.55,
            }),
        },
      );

    const old =
      fixture.proposals.find(
        (item) =>
          item.id ===
          first.proposal.id,
      )!;

    assert.equal(
      old.status,
      PinAIActionProposalStatus
        .SUPERSEDED,
    );
    assert.equal(
      old.supersededAt
        ?.toISOString(),
      NOW.toISOString(),
    );
    assert.notEqual(
      second.proposal.id,
      first.proposal.id,
    );
    assert.equal(
      fixture.proposals.length,
      2,
    );
  },
);

test(
  "confirmation is one-time, idempotent, and never executes the action",
  async () => {
    const fixture =
      createPrisma();
    const created =
      await createProposal(
        fixture,
      );

    const confirmed =
      await confirmPinAIActionProposal({
        prisma:
          fixture.prisma,
        guestToken:
          TOKEN_A,
        proposalId:
          created.proposal.id,
        confirmationToken:
          created
            .confirmationToken,
        now: NOW,
      });
    const replay =
      await confirmPinAIActionProposal({
        prisma:
          fixture.prisma,
        guestToken:
          TOKEN_A,
        proposalId:
          created.proposal.id,
        confirmationToken:
          created
            .confirmationToken,
        now: NOW,
      });

    assert.equal(
      confirmed
        .proposalConfirmed,
      true,
    );
    assert.equal(
      confirmed.actionExecuted,
      false,
    );
    assert.equal(
      confirmed
        .proposal.status,
      PinAIActionProposalStatus
        .CONFIRMED,
    );
    assert.equal(
      replay.idempotentReplay,
      true,
    );
    assert.equal(
      replay.actionExecuted,
      false,
    );
  },
);

test(
  "wrong confirmation token is rejected without changing proposal state",
  async () => {
    const fixture =
      createPrisma();
    const created =
      await createProposal(
        fixture,
      );

    await assert.rejects(
      () =>
        confirmPinAIActionProposal({
          prisma:
            fixture.prisma,
          guestToken:
            TOKEN_A,
          proposalId:
            created.proposal.id,
          confirmationToken:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          now: NOW,
        }),
      (error: unknown) =>
        error instanceof
          PinAIActionProposalError &&
        error.code ===
          "PROPOSAL_TOKEN_MISMATCH" &&
        error.statusCode === 403,
    );

    assert.equal(
      fixture.proposals[0]
        .status,
      PinAIActionProposalStatus
        .PENDING_CONFIRMATION,
    );
  },
);

test(
  "expired confirmation persists EXPIRED before returning the error",
  async () => {
    const fixture =
      createPrisma();
    const created =
      await createProposal(
        fixture,
        {
          expiresAt:
            new Date(
              NOW.getTime() +
                1_000,
            ),
        },
      );
    const later =
      new Date(
        NOW.getTime() +
          2_000,
      );

    await assert.rejects(
      () =>
        confirmPinAIActionProposal({
          prisma:
            fixture.prisma,
          guestToken:
            TOKEN_A,
          proposalId:
            created.proposal.id,
          confirmationToken:
            created
              .confirmationToken,
          now: later,
        }),
      (error: unknown) =>
        error instanceof
          PinAIActionProposalError &&
        error.code ===
          "PROPOSAL_EXPIRED" &&
        error.statusCode === 410,
    );

    assert.equal(
      fixture.proposals[0]
        .status,
      PinAIActionProposalStatus
        .EXPIRED,
    );
  },
);

test(
  "reservation version drift persists SUPERSEDED before returning the error",
  async () => {
    const fixture =
      createPrisma();
    const created =
      await createProposal(
        fixture,
      );

    fixture.reservations[0]
      .updatedAt =
      new Date(
        UPDATED_AT.getTime() +
          1_000,
      );

    await assert.rejects(
      () =>
        confirmPinAIActionProposal({
          prisma:
            fixture.prisma,
          guestToken:
            TOKEN_A,
          proposalId:
            created.proposal.id,
          confirmationToken:
            created
              .confirmationToken,
          now: NOW,
        }),
      (error: unknown) =>
        error instanceof
          PinAIActionProposalError &&
        error.code ===
          "PROPOSAL_SUPERSEDED",
    );

    assert.equal(
      fixture.proposals[0]
        .status,
      PinAIActionProposalStatus
        .SUPERSEDED,
    );
    assert.equal(
      fixture.proposals[0]
        .supersededAt
        ?.toISOString(),
      NOW.toISOString(),
    );
  },
);

test(
  "proposal cannot be confirmed through another reservation or tenant scope",
  async () => {
    const fixture =
      createPrisma([
        reservation(),
        reservation({
          id:
            "reservation-b",
          guestToken:
            TOKEN_B,
          propertyId:
            "property-b",
          property: {
            organizationId:
              "organization-b",
            status: "ACTIVE",
          },
        }),
      ]);
    const created =
      await createProposal(
        fixture,
      );

    await assert.rejects(
      () =>
        confirmPinAIActionProposal({
          prisma:
            fixture.prisma,
          guestToken:
            TOKEN_B,
          proposalId:
            created.proposal.id,
          confirmationToken:
            created
              .confirmationToken,
          now: NOW,
        }),
      (error: unknown) =>
        error instanceof
          PinAIActionProposalError &&
        error.code ===
          "PROPOSAL_SCOPE_MISMATCH" &&
        error.statusCode === 404,
    );

    assert.equal(
      fixture.proposals[0]
        .status,
      PinAIActionProposalStatus
        .PENDING_CONFIRMATION,
    );
  },
);

test(
  "a confirmed proposal can be superseded without erasing consent evidence",
  async () => {
    const fixture =
      createPrisma();
    const created =
      await createProposal(
        fixture,
      );

    const confirmed =
      await confirmPinAIActionProposal({
        prisma:
          fixture.prisma,
        guestToken:
          TOKEN_A,
        proposalId:
          created.proposal.id,
        confirmationToken:
          created
            .confirmationToken,
        now: NOW,
      });

    const confirmedAt =
      confirmed.proposal
        .confirmedAt;
    assert.ok(confirmedAt);

    const superseded =
      await supersedePinAIActionProposal({
        prisma:
          fixture.prisma,
        organizationId:
          "organization-a",
        propertyId:
          "property-a",
        reservationId:
          "reservation-a",
        proposalId:
          created.proposal.id,
        expectedProposalFingerprint:
          created.proposal
            .proposalFingerprint,
        now:
          new Date(
            NOW.getTime() +
              1_000,
          ),
      });

    assert.equal(
      superseded
        .proposal.status,
      PinAIActionProposalStatus
        .SUPERSEDED,
    );
    assert.equal(
      superseded.actionExecuted,
      false,
    );
    assert.equal(
      superseded
        .proposal.confirmedAt
        ?.toISOString(),
      confirmedAt.toISOString(),
    );
    assert.equal(
      superseded
        .proposal.supersededAt
        ?.toISOString(),
      new Date(
        NOW.getTime() +
          1_000,
      ).toISOString(),
    );

    const replay =
      await supersedePinAIActionProposal({
        prisma:
          fixture.prisma,
        organizationId:
          "organization-a",
        propertyId:
          "property-a",
        reservationId:
          "reservation-a",
        proposalId:
          created.proposal.id,
        expectedProposalFingerprint:
          created.proposal
            .proposalFingerprint,
        now:
          new Date(
            NOW.getTime() +
              2_000,
          ),
      });

    assert.equal(
      replay.idempotentReplay,
      true,
    );
    assert.equal(
      replay.actionExecuted,
      false,
    );
    assert.equal(
      replay
        .proposal.confirmedAt
        ?.toISOString(),
      confirmedAt.toISOString(),
    );
  },
);

test(
  "cancellation is idempotent and cannot execute an operational action",
  async () => {
    const fixture =
      createPrisma();
    const created =
      await createProposal(
        fixture,
      );

    const cancelled =
      await cancelPinAIActionProposal({
        prisma:
          fixture.prisma,
        guestToken:
          TOKEN_A,
        proposalId:
          created.proposal.id,
        now: NOW,
      });
    const replay =
      await cancelPinAIActionProposal({
        prisma:
          fixture.prisma,
        guestToken:
          TOKEN_A,
        proposalId:
          created.proposal.id,
        now: NOW,
      });

    assert.equal(
      cancelled
        .proposal.status,
      PinAIActionProposalStatus
        .CANCELLED,
    );
    assert.equal(
      cancelled.actionExecuted,
      false,
    );
    assert.equal(
      replay.idempotentReplay,
      true,
    );
    assert.equal(
      replay.actionExecuted,
      false,
    );
  },
);
