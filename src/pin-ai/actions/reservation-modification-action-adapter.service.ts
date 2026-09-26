import { formatInTimeZone } from "date-fns-tz";
import {
  PinAIActionProposalStatus,
  PinAIActionProposalType,
  ReservationModificationStatus,
  type PrismaClient,
} from "@prisma/client";

import {
  confirmGuestReservationModification,
  getGuestReservationModificationPreview,
  GuestReservationModificationError,
} from "../../services/guest-reservation-modification.service.js";
import {
  createPinAIActionProposal,
  supersedePinAIActionProposal,
} from "./action-proposal.service.js";

export const PIN_AI_RESERVATION_MODIFICATION_TERMS_VERSION =
  "pin_ai_reservation_modification_terms_v1" as const;

export const PIN_AI_RESERVATION_MODIFICATION_QUOTE_TTL_MS =
  60 * 60 * 1000;

export type PinAIReservationModificationActionOutcome =
  | "EXECUTED"
  | "WAITING_FOR_PAYMENT"
  | "WAITING_FOR_HOST"
  | "REVIEW_REQUIRED";

type Language = "en" | "es";

type PrepareInput = Readonly<{
  guestToken: string;
  checkIn: Date;
  checkOut: Date;
  adults: number;
  children: number;
  selectedAmenityIds?: string[];
  language: Language;
}>;

type ExecuteInput = Readonly<{
  guestToken: string;
  proposalId: string;
}>;

type TermsV1 = Readonly<{
  version: typeof PIN_AI_RESERVATION_MODIFICATION_TERMS_VERSION;
  quotedAt: string;
  quoteExpiresAt: string;
  priceGuaranteedUntil: string;
  availabilityCheckedAt: string;
  availabilityHeld: false;
  propertyTimezone: string;
  quoteExpiresAtLocal: string;
  previewFingerprint: string;
  reservationVersion: string;
  currency: string;
  current: Readonly<{
    checkIn: string;
    checkOut: string;
    adults: number;
    children: number;
    selectedAmenityIds: string[];
    totalAmountCents: number;
  }>;
  proposed: Readonly<{
    checkIn: string;
    checkOut: string;
    adults: number;
    children: number;
    selectedAmenityIds: string[];
  }>;
  pricing: Readonly<{
    proposedTotalAmountCents: number;
    amountDifferenceCents: number;
    financialAction: string;
    reductionPolicy: unknown;
  }>;
}>;

type ProposalRecord = Readonly<{
  id: string;
  organizationId: string;
  propertyId: string;
  reservationId: string;
  actionType: PinAIActionProposalType;
  status: PinAIActionProposalStatus;
  proposalFingerprint: string;
  termsSnapshot: unknown;
  expiresAt: Date;
  confirmedAt: Date | null;
  supersededAt: Date | null;
  reservation: Readonly<{
    id: string;
    propertyId: string;
    guestTokenExpiresAt: Date | null;
    property: Readonly<{
      organizationId: string;
    }>;
  }>;
}>;

type AdapterPrisma = Pick<
  PrismaClient,
  "pinAIActionProposal"
>;

export type PinAIReservationModificationActionAdapterDependencies =
  Readonly<{
    prisma: AdapterPrisma;
    getPreview: typeof getGuestReservationModificationPreview;
    createProposal: typeof createPinAIActionProposal;
    supersedeProposal: typeof supersedePinAIActionProposal;
    confirmModification: typeof confirmGuestReservationModification;
    createCheckout: (input: Readonly<{
      guestToken: string;
      modificationId: string;
    }>) => Promise<Readonly<{
      checkoutUrl: string | null;
      checkoutExpiresAt: Date;
    }>>;
    applyModification: (input: Readonly<{
      modificationId: string;
    }>) => Promise<Readonly<{
      modification: Readonly<{
        id: string;
        status: ReservationModificationStatus;
      }>;
    }>>;
    now: () => Date;
  }>;

export class PinAIReservationModificationActionError
  extends Error {
  constructor(
    readonly code:
      | "INVALID_GUEST_TOKEN"
      | "INVALID_PROPOSAL_ID"
      | "INVALID_LANGUAGE"
      | "INVALID_QUOTE_TERMS"
      | "ACTION_PROPOSAL_NOT_FOUND"
      | "ACTION_PROPOSAL_NOT_CONFIRMED"
      | "ACTION_PROPOSAL_SCOPE_MISMATCH"
      | "ACTION_PROPOSAL_QUOTE_EXPIRED"
      | "ACTION_PROPOSAL_QUOTE_CHANGED"
      | "CHECKOUT_URL_UNAVAILABLE"
      | "UNSUPPORTED_MODIFICATION_STATE",
    readonly statusCode = 409,
  ) {
    super(`PIN_AI_RESERVATION_MODIFICATION_${code}`);
    this.name =
      "PinAIReservationModificationActionError";
  }
}

const fail = (
  code:
    PinAIReservationModificationActionError["code"],
  statusCode = 409,
): never => {
  throw new PinAIReservationModificationActionError(
    code,
    statusCode,
  );
};

function text(
  value: unknown,
  code:
    PinAIReservationModificationActionError["code"],
  max = 256,
) {
  const normalized =
    typeof value === "string"
      ? value.trim()
      : "";

  if (
    !normalized ||
    normalized.length > max
  ) {
    return fail(code, 400);
  }

  return normalized;
}

function guestToken(value: unknown) {
  const normalized =
    text(
      value,
      "INVALID_GUEST_TOKEN",
      200,
    );

  if (
    !/^[A-Za-z0-9_-]{16,200}$/.test(
      normalized,
    )
  ) {
    return fail(
      "INVALID_GUEST_TOKEN",
      400,
    );
  }

  return normalized;
}

function proposalId(value: unknown) {
  const normalized =
    text(
      value,
      "INVALID_PROPOSAL_ID",
      128,
    );

  if (
    !/^[A-Za-z0-9_-]{8,128}$/.test(
      normalized,
    )
  ) {
    return fail(
      "INVALID_PROPOSAL_ID",
      400,
    );
  }

  return normalized;
}

function language(
  value: unknown,
): Language {
  if (value !== "en" && value !== "es") {
    return fail(
      "INVALID_LANGUAGE",
      400,
    );
  }

  return value;
}

function date(
  value: unknown,
) {
  const parsed =
    value instanceof Date
      ? new Date(value)
      : new Date(
          String(value ?? ""),
        );

  if (
    Number.isNaN(
      parsed.getTime(),
    )
  ) {
    return fail(
      "INVALID_QUOTE_TERMS",
      409,
    );
  }

  return parsed;
}

function signedInteger(value: unknown) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return fail(
      "INVALID_QUOTE_TERMS",
      409,
    );
  }

  return parsed;
}

function integer(
  value: unknown,
  minimum = 0,
) {
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum
  ) {
    return fail(
      "INVALID_QUOTE_TERMS",
      409,
    );
  }

  return parsed;
}

function stringArray(
  value: unknown,
) {
  if (!Array.isArray(value)) {
    return fail(
      "INVALID_QUOTE_TERMS",
      409,
    );
  }

  return Array.from(
    new Set(
      value.map((item) =>
        text(
          item,
          "INVALID_QUOTE_TERMS",
          160,
        ),
      ),
    ),
  ).sort();
}

function safeTimezone(
  value: unknown,
) {
  const candidate =
    typeof value === "string" &&
    value.trim()
      ? value.trim()
      : "UTC";

  try {
    new Intl.DateTimeFormat(
      "en-US",
      { timeZone: candidate },
    ).format(new Date());
    return candidate;
  } catch {
    return "UTC";
  }
}

function formatLocalExpiry(
  value: Date,
  timeZone: string,
) {
  return formatInTimeZone(
    value,
    timeZone,
    "yyyy-MM-dd'T'HH:mm:ssXXX",
  );
}

function amountText(
  cents: number,
  currency: string,
  locale: Language,
) {
  try {
    return new Intl.NumberFormat(
      locale === "es"
        ? "es-PR"
        : "en-US",
      {
        style: "currency",
        currency:
          currency.toUpperCase(),
      },
    ).format(cents / 100);
  } catch {
    return `${(
      cents / 100
    ).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

function consentText(
  input: Readonly<{
    language: Language;
    terms: TermsV1;
  }>,
) {
  const current =
    amountText(
      input.terms.current
        .totalAmountCents,
      input.terms.currency,
      input.language,
    );
  const proposed =
    amountText(
      input.terms.pricing
        .proposedTotalAmountCents,
      input.terms.currency,
      input.language,
    );
  const difference =
    amountText(
      input.terms.pricing
        .amountDifferenceCents,
      input.terms.currency,
      input.language,
    );

  const financialNote =
    input.terms.pricing
      .financialAction ===
      "NO_REFUND_DUE_CONFIRMATION_REQUIRED"
      ? input.language === "es"
        ? " Entiendo que esta reducción no genera reembolso según los términos aplicables."
        : " I understand that this reduction does not generate a refund under the applicable terms."
      : input.terms.pricing
          .financialAction ===
          "REDUCTION_REVIEW_REQUIRED"
        ? input.language === "es"
          ? " Este cambio requiere revisión o aprobación del anfitrión antes de modificar la reservación."
          : " This change requires host review or approval before the reservation is modified."
        : "";

  if (input.language === "es") {
    return [
      "Confirmo los cambios de reservación y los términos mostrados.",
      `Total actual: ${current}. Nuevo total: ${proposed}. Diferencia: ${difference}.`,
      `Esta cotización de precio puede aceptarse hasta ${input.terms.quoteExpiresAtLocal} (${input.terms.propertyTimezone}).`,
      "La disponibilidad se volverá a verificar antes de completar el cambio; esta cotización no retiene las fechas.",
      financialNote.trim(),
    ]
      .filter(Boolean)
      .join(" ");
  }

  return [
    "I confirm the reservation changes and the terms shown.",
    `Current total: ${current}. New total: ${proposed}. Difference: ${difference}.`,
    `This price quote may be accepted until ${input.terms.quoteExpiresAtLocal} (${input.terms.propertyTimezone}).`,
    "Availability will be checked again before the change is completed; this quote does not hold the dates.",
    financialNote.trim(),
  ]
    .filter(Boolean)
    .join(" ");
}

function parseTerms(
  value: unknown,
): TermsV1 {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return fail(
      "INVALID_QUOTE_TERMS",
      409,
    );
  }

  const root =
    value as Record<
      string,
      unknown
    >;

  if (
    root.version !==
      PIN_AI_RESERVATION_MODIFICATION_TERMS_VERSION ||
    root.availabilityHeld !== false
  ) {
    return fail(
      "INVALID_QUOTE_TERMS",
      409,
    );
  }

  const current =
    root.current &&
    typeof root.current === "object" &&
    !Array.isArray(root.current)
      ? root.current as
          Record<string, unknown>
      : fail(
          "INVALID_QUOTE_TERMS",
          409,
        );
  const proposed =
    root.proposed &&
    typeof root.proposed === "object" &&
    !Array.isArray(root.proposed)
      ? root.proposed as
          Record<string, unknown>
      : fail(
          "INVALID_QUOTE_TERMS",
          409,
        );
  const pricing =
    root.pricing &&
    typeof root.pricing === "object" &&
    !Array.isArray(root.pricing)
      ? root.pricing as
          Record<string, unknown>
      : fail(
          "INVALID_QUOTE_TERMS",
          409,
        );

  const previewFingerprint =
    text(
      root.previewFingerprint,
      "INVALID_QUOTE_TERMS",
      64,
    ).toLowerCase();

  if (
    !/^[a-f0-9]{64}$/.test(
      previewFingerprint,
    )
  ) {
    return fail(
      "INVALID_QUOTE_TERMS",
      409,
    );
  }

  const reservationVersion =
    date(
      root.reservationVersion,
    ).toISOString();
  const quotedAt =
    date(root.quotedAt)
      .toISOString();
  const quoteExpiresAt =
    date(root.quoteExpiresAt)
      .toISOString();
  const priceGuaranteedUntil =
    date(
      root.priceGuaranteedUntil,
    ).toISOString();
  const availabilityCheckedAt =
    date(
      root.availabilityCheckedAt,
    ).toISOString();

  if (
    quoteExpiresAt !==
      priceGuaranteedUntil ||
    new Date(quoteExpiresAt) <=
      new Date(quotedAt)
  ) {
    return fail(
      "INVALID_QUOTE_TERMS",
      409,
    );
  }

  const currency =
    text(
      root.currency,
      "INVALID_QUOTE_TERMS",
      3,
    ).toLowerCase();

  if (!/^[a-z]{3}$/.test(currency)) {
    return fail(
      "INVALID_QUOTE_TERMS",
      409,
    );
  }

  const propertyTimezone =
    safeTimezone(
      root.propertyTimezone,
    );
  const quoteExpiresAtLocal =
    text(
      root.quoteExpiresAtLocal,
      "INVALID_QUOTE_TERMS",
      80,
    );

  if (
    quoteExpiresAtLocal !==
    formatLocalExpiry(
      new Date(quoteExpiresAt),
      propertyTimezone,
    )
  ) {
    return fail(
      "INVALID_QUOTE_TERMS",
      409,
    );
  }

  return {
    version:
      PIN_AI_RESERVATION_MODIFICATION_TERMS_VERSION,
    quotedAt,
    quoteExpiresAt,
    priceGuaranteedUntil,
    availabilityCheckedAt,
    availabilityHeld: false,
    propertyTimezone,
    quoteExpiresAtLocal,
    previewFingerprint,
    reservationVersion,
    currency,
    current: {
      checkIn:
        date(
          current.checkIn,
        ).toISOString(),
      checkOut:
        date(
          current.checkOut,
        ).toISOString(),
      adults:
        integer(
          current.adults,
          1,
        ),
      children:
        integer(
          current.children,
          0,
        ),
      selectedAmenityIds:
        stringArray(
          current.selectedAmenityIds,
        ),
      totalAmountCents:
        integer(
          current.totalAmountCents,
          1,
        ),
    },
    proposed: {
      checkIn:
        date(
          proposed.checkIn,
        ).toISOString(),
      checkOut:
        date(
          proposed.checkOut,
        ).toISOString(),
      adults:
        integer(
          proposed.adults,
          1,
        ),
      children:
        integer(
          proposed.children,
          0,
        ),
      selectedAmenityIds:
        stringArray(
          proposed.selectedAmenityIds,
        ),
    },
    pricing: {
      proposedTotalAmountCents:
        integer(
          pricing
            .proposedTotalAmountCents,
          1,
        ),
      amountDifferenceCents:
        signedInteger(
          pricing
            .amountDifferenceCents,
        ),
      financialAction:
        text(
          pricing.financialAction,
          "INVALID_QUOTE_TERMS",
          80,
        ),
      reductionPolicy:
        pricing.reductionPolicy ??
        null,
    },
  };
}

function buildTerms(
  input: Readonly<{
    preview:
      Awaited<
        ReturnType<
          typeof getGuestReservationModificationPreview
        >
      >;
    now: Date;
    quoteExpiresAt: Date;
  }>,
): TermsV1 {
  const propertyTimezone =
    safeTimezone(
      input.preview.property
        .timezone,
    );
  const currency =
    String(
      input.preview.reservation
        .currency ?? "",
    )
      .trim()
      .toLowerCase();

  if (!/^[a-z]{3}$/.test(currency)) {
    return fail(
      "INVALID_QUOTE_TERMS",
      409,
    );
  }

  const proposedTotalAmountCents =
    Number(
      input.preview.pricing
        .proposed.totalAmountCents,
    );

  if (
    !Number.isSafeInteger(
      proposedTotalAmountCents,
    ) ||
    proposedTotalAmountCents <= 0
  ) {
    return fail(
      "INVALID_QUOTE_TERMS",
      409,
    );
  }

  return {
    version:
      PIN_AI_RESERVATION_MODIFICATION_TERMS_VERSION,
    quotedAt:
      input.now.toISOString(),
    quoteExpiresAt:
      input.quoteExpiresAt
        .toISOString(),
    priceGuaranteedUntil:
      input.quoteExpiresAt
        .toISOString(),
    availabilityCheckedAt:
      input.now.toISOString(),
    availabilityHeld: false,
    propertyTimezone,
    quoteExpiresAtLocal:
      formatLocalExpiry(
        input.quoteExpiresAt,
        propertyTimezone,
      ),
    previewFingerprint:
      input.preview
        .previewFingerprint,
    reservationVersion:
      input.preview.reservation
        .version.toISOString(),
    currency,
    current: {
      checkIn:
        input.preview.reservation
          .current.checkIn
          .toISOString(),
      checkOut:
        input.preview.reservation
          .current.checkOut
          .toISOString(),
      adults:
        input.preview.reservation
          .current.adults,
      children:
        input.preview.reservation
          .current.children,
      selectedAmenityIds:
        [...input.preview.reservation
          .current
          .selectedAmenityIds]
          .sort(),
      totalAmountCents:
        input.preview.pricing
          .currentTotalAmountCents,
    },
    proposed: {
      checkIn:
        input.preview.reservation
          .proposed.checkIn
          .toISOString(),
      checkOut:
        input.preview.reservation
          .proposed.checkOut
          .toISOString(),
      adults:
        input.preview.reservation
          .proposed.adults,
      children:
        input.preview.reservation
          .proposed.children,
      selectedAmenityIds:
        [...input.preview.reservation
          .proposed
          .selectedAmenityIds]
          .sort(),
    },
    pricing: {
      proposedTotalAmountCents,
      amountDifferenceCents:
        input.preview.pricing
          .amountDifferenceCents,
      financialAction:
        input.preview.pricing
          .financialAction,
      reductionPolicy:
        input.preview.pricing
          .reductionPolicy,
    },
  };
}

function clientRequestId(
  proposalIdValue: string,
) {
  return `pin_ai_${proposalIdValue}`;
}

function acceptNoRefundReduction(
  terms: TermsV1,
) {
  return (
    terms.pricing
      .financialAction ===
    "NO_REFUND_DUE_CONFIRMATION_REQUIRED"
  );
}

function output(
  input: Readonly<{
    outcome:
      PinAIReservationModificationActionOutcome;
    actionExecuted: boolean;
    proposalId: string;
    quoteExpiresAt: Date;
    propertyTimezone: string;
    modificationId?: string;
    modificationStatus?: ReservationModificationStatus;
    checkoutUrl?: string | null;
    paymentExpiresAt?: Date | null;
    amountDifferenceCents: number;
    currency: string;
    reasonCode?: string;
  }>,
) {
  return {
    ok: true as const,
    outcome: input.outcome,
    actionExecuted:
      input.actionExecuted,
    proposalId:
      input.proposalId,
    quoteExpiresAt:
      input.quoteExpiresAt,
    quoteExpiresAtLocal:
      formatLocalExpiry(
        input.quoteExpiresAt,
        input.propertyTimezone,
      ),
    propertyTimezone:
      input.propertyTimezone,
    availabilityHeld:
      false as const,
    modificationId:
      input.modificationId ??
      null,
    modificationStatus:
      input.modificationStatus ??
      null,
    checkoutUrl:
      input.checkoutUrl ??
      null,
    paymentExpiresAt:
      input.paymentExpiresAt ??
      null,
    amountDifference:
      input.amountDifferenceCents /
      100,
    amountDifferenceCents:
      input.amountDifferenceCents,
    currency:
      input.currency,
    reasonCode:
      input.reasonCode ??
      null,
  };
}

export class PinAIReservationModificationActionAdapter {
  constructor(
    private readonly dependencies:
      PinAIReservationModificationActionAdapterDependencies,
  ) {}

  async prepare(
    input: PrepareInput,
  ) {
    const cleanGuestToken =
      guestToken(input.guestToken);
    const cleanLanguage =
      language(input.language);
    const now =
      this.dependencies.now();
    const quoteExpiresAt =
      new Date(
        now.getTime() +
          PIN_AI_RESERVATION_MODIFICATION_QUOTE_TTL_MS,
      );

    const preview =
      await this.dependencies
        .getPreview({
          guestToken:
            cleanGuestToken,
          checkIn:
            input.checkIn,
          checkOut:
            input.checkOut,
          adults:
            input.adults,
          children:
            input.children,
          selectedAmenityIds:
            input.selectedAmenityIds,
        });

    if (!preview.changes.hasChanges) {
      return fail(
        "INVALID_QUOTE_TERMS",
        400,
      );
    }

    const terms =
      buildTerms({
        preview,
        now,
        quoteExpiresAt,
      });

    const created =
      await this.dependencies
        .createProposal({
          prisma:
            this.dependencies.prisma as PrismaClient,
          guestToken:
            cleanGuestToken,
          actionType:
            PinAIActionProposalType
              .RESERVATION_MODIFICATION,
          language:
            cleanLanguage,
          consentText:
            consentText({
              language:
                cleanLanguage,
              terms,
            }),
          termsSnapshot:
            terms,
          expiresAt:
            quoteExpiresAt,
          now,
        });

    return {
      ok: true as const,
      actionExecuted:
        false as const,
      proposal:
        created.proposal,
      confirmationToken:
        created.confirmationToken,
      quote: {
        quotedAt:
          new Date(
            terms.quotedAt,
          ),
        quoteExpiresAt:
          created.proposal
            .expiresAt,
        quoteExpiresAtLocal:
          formatLocalExpiry(
            created.proposal
              .expiresAt,
            terms.propertyTimezone,
          ),
        priceGuaranteedUntil:
          created.proposal
            .expiresAt,
        propertyTimezone:
          terms.propertyTimezone,
        availabilityCheckedAt:
          new Date(
            terms.availabilityCheckedAt,
          ),
        availabilityHeld:
          false as const,
        currentTotalAmount:
          terms.current
            .totalAmountCents /
          100,
        proposedTotalAmount:
          terms.pricing
            .proposedTotalAmountCents /
          100,
        amountDifference:
          terms.pricing
            .amountDifferenceCents /
          100,
        amountDifferenceCents:
          terms.pricing
            .amountDifferenceCents,
        currency:
          terms.currency,
        financialAction:
          terms.pricing
            .financialAction,
      },
    };
  }

  async execute(
    input: ExecuteInput,
  ) {
    const cleanGuestToken =
      guestToken(input.guestToken);
    const cleanProposalId =
      proposalId(input.proposalId);
    const now =
      this.dependencies.now();

    const proposal =
      await this.dependencies
        .prisma.pinAIActionProposal
        .findFirst({
          where: {
            id:
              cleanProposalId,
            actionType:
              PinAIActionProposalType
                .RESERVATION_MODIFICATION,
            reservation: {
              guestToken:
                cleanGuestToken,
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
            },
          },
          include: {
            reservation: {
              select: {
                id: true,
                propertyId: true,
                guestTokenExpiresAt:
                  true,
                property: {
                  select: {
                    organizationId:
                      true,
                  },
                },
              },
            },
          },
        }) as ProposalRecord | null;

    if (!proposal) {
      return fail(
        "ACTION_PROPOSAL_NOT_FOUND",
        404,
      );
    }

    if (
      proposal.organizationId !==
        proposal.reservation
          .property
          .organizationId ||
      proposal.propertyId !==
        proposal.reservation
          .propertyId ||
      proposal.reservationId !==
        proposal.reservation.id
    ) {
      return fail(
        "ACTION_PROPOSAL_SCOPE_MISMATCH",
        404,
      );
    }

    if (
      proposal.status !==
        PinAIActionProposalStatus
          .CONFIRMED ||
      !proposal.confirmedAt
    ) {
      return fail(
        "ACTION_PROPOSAL_NOT_CONFIRMED",
        409,
      );
    }

    const terms =
      parseTerms(
        proposal.termsSnapshot,
      );
    const quoteExpiresAt =
      new Date(
        terms.quoteExpiresAt,
      );

    if (
      proposal.expiresAt <= now ||
      quoteExpiresAt <= now
    ) {
      await this.dependencies
        .supersedeProposal({
          prisma:
            this.dependencies.prisma as PrismaClient,
          organizationId:
            proposal.organizationId,
          propertyId:
            proposal.propertyId,
          reservationId:
            proposal.reservationId,
          proposalId:
            proposal.id,
          expectedProposalFingerprint:
            proposal.proposalFingerprint,
          now,
        });

      return output({
        outcome:
          "REVIEW_REQUIRED",
        actionExecuted:
          false,
        proposalId:
          proposal.id,
        quoteExpiresAt,
        propertyTimezone:
          terms.propertyTimezone,
        amountDifferenceCents:
          terms.pricing
            .amountDifferenceCents,
        currency:
          terms.currency,
        reasonCode:
          "QUOTE_EXPIRED",
      });
    }

    const freshPreview =
      await this.dependencies
        .getPreview({
          guestToken:
            cleanGuestToken,
          checkIn:
            date(
              terms.proposed
                .checkIn,
            ),
          checkOut:
            date(
              terms.proposed
                .checkOut,
            ),
          adults:
            terms.proposed
              .adults,
          children:
            terms.proposed
              .children,
          selectedAmenityIds:
            terms.proposed
              .selectedAmenityIds,
        });

    if (
      freshPreview
        .previewFingerprint !==
      terms.previewFingerprint
    ) {
      await this.dependencies
        .supersedeProposal({
          prisma:
            this.dependencies.prisma as PrismaClient,
          organizationId:
            proposal.organizationId,
          propertyId:
            proposal.propertyId,
          reservationId:
            proposal.reservationId,
          proposalId:
            proposal.id,
          expectedProposalFingerprint:
            proposal.proposalFingerprint,
          now,
        });

      return output({
        outcome:
          "REVIEW_REQUIRED",
        actionExecuted:
          false,
        proposalId:
          proposal.id,
        quoteExpiresAt,
        propertyTimezone:
          terms.propertyTimezone,
        amountDifferenceCents:
          terms.pricing
            .amountDifferenceCents,
        currency:
          terms.currency,
        reasonCode:
          "QUOTE_CHANGED",
      });
    }

    let confirmed;

    try {
      confirmed =
        await this.dependencies
          .confirmModification({
            guestToken:
              cleanGuestToken,
            clientRequestId:
              clientRequestId(
                proposal.id,
              ),
            checkIn:
              date(
                terms.proposed
                  .checkIn,
              ),
            checkOut:
              date(
                terms.proposed
                  .checkOut,
              ),
            adults:
              terms.proposed
                .adults,
            children:
              terms.proposed
                .children,
            selectedAmenityIds:
              terms.proposed
                .selectedAmenityIds,
            acceptNoRefundReduction:
              acceptNoRefundReduction(
                terms,
              ),
            expectedPreviewFingerprint:
              terms.previewFingerprint,
            confirmationSource:
              "PIN_AI_GUEST_SERVICES",
            actionProposalId:
              proposal.id,
            actionProposalFingerprint:
              proposal.proposalFingerprint,
            actionProposalConfirmedAt:
              proposal.confirmedAt,
          });
    } catch (error) {
      if (
        error instanceof
          GuestReservationModificationError &&
        error.code ===
          "RESERVATION_MODIFICATION_PREVIEW_CHANGED"
      ) {
        await this.dependencies
          .supersedeProposal({
            prisma:
              this.dependencies.prisma as PrismaClient,
            organizationId:
              proposal.organizationId,
            propertyId:
              proposal.propertyId,
            reservationId:
              proposal.reservationId,
            proposalId:
              proposal.id,
            expectedProposalFingerprint:
              proposal.proposalFingerprint,
            now,
          });

        return output({
          outcome:
            "REVIEW_REQUIRED",
          actionExecuted:
            false,
          proposalId:
            proposal.id,
          quoteExpiresAt,
          propertyTimezone:
            terms.propertyTimezone,
          amountDifferenceCents:
            terms.pricing
              .amountDifferenceCents,
          currency:
            terms.currency,
          reasonCode:
            "QUOTE_CHANGED",
        });
      }

      throw error;
    }

    const modification =
      confirmed.modification;

    if (
      modification.status ===
      ReservationModificationStatus
        .APPLYING
    ) {
      const applied =
        await this.dependencies
          .applyModification({
            modificationId:
              modification.id,
          });

      return output({
        outcome:
          "EXECUTED",
        actionExecuted:
          applied.modification
            .status ===
          ReservationModificationStatus
            .APPLIED,
        proposalId:
          proposal.id,
        quoteExpiresAt,
        propertyTimezone:
          terms.propertyTimezone,
        modificationId:
          applied.modification.id,
        modificationStatus:
          applied.modification.status,
        amountDifferenceCents:
          terms.pricing
            .amountDifferenceCents,
        currency:
          terms.currency,
      });
    }

    if (
      modification.status ===
      ReservationModificationStatus
        .AWAITING_PAYMENT
    ) {
      try {
        const checkout =
          await this.dependencies
            .createCheckout({
              guestToken:
                cleanGuestToken,
              modificationId:
                modification.id,
            });

        if (!checkout.checkoutUrl) {
          return fail(
            "CHECKOUT_URL_UNAVAILABLE",
            502,
          );
        }

        return output({
          outcome:
            "WAITING_FOR_PAYMENT",
          actionExecuted:
            false,
          proposalId:
            proposal.id,
          quoteExpiresAt,
          propertyTimezone:
            terms.propertyTimezone,
          modificationId:
            modification.id,
          modificationStatus:
            modification.status,
          checkoutUrl:
            checkout.checkoutUrl,
          paymentExpiresAt:
            checkout
              .checkoutExpiresAt,
          amountDifferenceCents:
            terms.pricing
              .amountDifferenceCents,
          currency:
            terms.currency,
        });
      } catch (error) {
        if (
          error instanceof
            GuestReservationModificationError &&
          [
            "RESERVATION_MODIFICATION_PRICE_CHANGED",
            "RESERVATION_CHANGED_RETRY_PREVIEW",
            "PROPERTY_NOT_AVAILABLE_FOR_SELECTED_DATES",
            "RESERVATION_MODIFICATION_CHECKOUT_WINDOW_EXPIRED",
          ].includes(error.code)
        ) {
          await this.dependencies
            .supersedeProposal({
              prisma:
                this.dependencies.prisma as PrismaClient,
              organizationId:
                proposal.organizationId,
              propertyId:
                proposal.propertyId,
              reservationId:
                proposal.reservationId,
              proposalId:
                proposal.id,
              expectedProposalFingerprint:
                proposal.proposalFingerprint,
              now,
            });

          return output({
            outcome:
              "REVIEW_REQUIRED",
            actionExecuted:
              false,
            proposalId:
              proposal.id,
            quoteExpiresAt,
            propertyTimezone:
              terms.propertyTimezone,
            modificationId:
              modification.id,
            modificationStatus:
              modification.status,
            amountDifferenceCents:
              terms.pricing
                .amountDifferenceCents,
            currency:
              terms.currency,
            reasonCode:
              "QUOTE_OR_AVAILABILITY_CHANGED",
          });
        }

        throw error;
      }
    }

    if (
      modification.status ===
      ReservationModificationStatus
        .HOST_APPROVAL_REQUIRED
    ) {
      return output({
        outcome:
          "WAITING_FOR_HOST",
        actionExecuted:
          false,
        proposalId:
          proposal.id,
        quoteExpiresAt,
        propertyTimezone:
          terms.propertyTimezone,
        modificationId:
          modification.id,
        modificationStatus:
          modification.status,
        amountDifferenceCents:
          terms.pricing
            .amountDifferenceCents,
        currency:
          terms.currency,
        reasonCode:
          "HOST_APPROVAL_REQUIRED",
      });
    }

    if (
      modification.status ===
      ReservationModificationStatus
        .APPLIED
    ) {
      return output({
        outcome:
          "EXECUTED",
        actionExecuted:
          true,
        proposalId:
          proposal.id,
        quoteExpiresAt,
        propertyTimezone:
          terms.propertyTimezone,
        modificationId:
          modification.id,
        modificationStatus:
          modification.status,
        amountDifferenceCents:
          terms.pricing
            .amountDifferenceCents,
        currency:
          terms.currency,
      });
    }

    return fail(
      "UNSUPPORTED_MODIFICATION_STATE",
      409,
    );
  }
}

