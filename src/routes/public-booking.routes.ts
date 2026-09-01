import { Router } from "express";
import { PrismaClient, ReservationModificationStatus } from "@prisma/client";
import {
  checkPropertyAvailability,
  getPropertyBlockedDateKeys,
} from "../services/availability.service";
import stripe from "../billing/stripe";
import { calculateDirectBookingPricing } from "../services/direct-booking-pricing.service";
import { calculateDirectBookingConnectFee } from "../services/direct-booking-connect-fee.service";
import { assertDirectBookingPayoutReady } from "../services/stripe-connect.service";
import { getActivePropertyGuestAgreement } from "../services/guest-agreement.service";
import {
  buildCancellationPolicySnapshot,
  buildGuestCancellationTermsText,
  renderCancellationPolicySnapshot,
  serializeCancellationPolicySnapshotForStripeMetadata,
} from "../services/cancellation-policy.service";
import {
  cancelReservationFromGuestPortal,
  getGuestCancellationPreview,
} from "../services/guest-cancellation.service";
import {
  confirmGuestReservationModification,
  getGuestReservationModificationOptions,
  getGuestReservationModificationPreview,
} from "../services/guest-reservation-modification.service";
import { createGuestReservationModificationCheckout } from "../services/guest-reservation-modification-checkout.service";
import { applyGuestReservationModification } from "../services/guest-reservation-modification-apply.service";
import { resolveOrganizationGuestReplyTo } from "../services/organization-guest-email.service";
import {
  resolvePublishedBrandContextForOrganization,
  type PublishedBrandContext,
} from "../services/branding/published-brand-context.service.js";

const prisma = new PrismaClient();
const publicBookingRouter = Router();

const SECURE_PRECHECKIN_DISCLOSURE_VERSION =
  "secure_precheckin_disclosure_v1";

const SECURE_PRECHECKIN_DISCLOSURE_SOURCE =
  "DIRECT_BOOKING_WEB_FORM";

function publicBookingBrandContext(context: PublishedBrandContext) {
  return {
    kind: context.kind,
    displayName: context.displayName,
    logoUrl: context.logoUrl,
    faviconUrl: context.faviconUrl,
    primaryColor: context.primaryColor,
    onPrimaryColor: context.onPrimaryColor,
    organizationSlug: context.organizationSlug,
    version: context.version,
    poweredByPinGo: context.poweredByPinGo,
  };
}

async function resolvePublicBookingBrandContext(organizationId: string) {
  try {
    const context = await resolvePublishedBrandContextForOrganization(
      organizationId
    );
    return publicBookingBrandContext(context);
  } catch (error) {
    console.error("[public-booking brand-context error]", {
      name: error instanceof Error ? error.name : "UnknownError",
    });
    return null;
  }
}

function buildSecurePrecheckinDisclosureText(
  identityVerificationRequired: boolean
) {
  const identityRequirement = identityVerificationRequired
    ? "The primary guest must complete Identity Check and accept the Guest Agreement. "
    : "The primary guest must accept the Guest Agreement. Identity Check is not required for this reservation. ";
  const identityRequirementEs = identityVerificationRequired
    ? "El huésped principal debe completar la Verificación de Identidad y aceptar el Acuerdo del Huésped. "
    : "El huésped principal debe aceptar el Acuerdo del Huésped. Esta reservación no requiere Verificación de Identidad. ";

  return (
    "Secure Pre-check-in is required before access credentials are released. " +
    identityRequirement +
    "Payment may confirm the reservation, but it does not complete these requirements or release access credentials. " +
    "El Registro Seguro es obligatorio antes de que se liberen las credenciales de acceso. " +
    identityRequirementEs +
    "El pago puede confirmar la reservación, pero no completa estos requisitos ni libera las credenciales de acceso."
  );
}

function parseDate(value: unknown) {
  const date = new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

function parseDateKey(value: unknown) {
  const raw = String(value ?? "").trim();

  const dateKeyMatch = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);

  if (dateKeyMatch) {
    const year = Number(dateKeyMatch[1]);
    const month = Number(dateKeyMatch[2]);
    const day = Number(dateKeyMatch[3]);

    const utcDate = new Date(Date.UTC(year, month - 1, day));

    if (
      utcDate.getUTCFullYear() === year &&
      utcDate.getUTCMonth() === month - 1 &&
      utcDate.getUTCDate() === day
    ) {
      return `${dateKeyMatch[1]}-${dateKeyMatch[2]}-${dateKeyMatch[3]}`;
    }

    return null;
  }

  const parsedDate = parseDate(value);

  return parsedDate ? parsedDate.toISOString().slice(0, 10) : null;
}

function normalizePropertyTimeZone(value: unknown) {
  const timezone = String(value ?? "").trim() || "America/Puerto_Rico";

  try {
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
    }).format(new Date());

    return timezone;
  } catch {
    return "America/Puerto_Rico";
  }
}

function parsePropertyTime(
  value: unknown,
  fallback: { hour: number; minute: number }
) {
  const raw = String(value ?? "").trim();

  const twentyFourHourMatch = raw.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);

  if (twentyFourHourMatch) {
    const hour = Number(twentyFourHourMatch[1]);
    const minute = Number(twentyFourHourMatch[2]);

    if (
      Number.isInteger(hour) &&
      Number.isInteger(minute) &&
      hour >= 0 &&
      hour <= 23 &&
      minute >= 0 &&
      minute <= 59
    ) {
      return { hour, minute };
    }
  }

  const twelveHourMatch = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);

  if (twelveHourMatch) {
    let hour = Number(twelveHourMatch[1]);
    const minute = twelveHourMatch[2] ? Number(twelveHourMatch[2]) : 0;
    const period = twelveHourMatch[3].toUpperCase();

    if (
      Number.isInteger(hour) &&
      Number.isInteger(minute) &&
      hour >= 1 &&
      hour <= 12 &&
      minute >= 0 &&
      minute <= 59
    ) {
      if (period === "AM" && hour === 12) {
        hour = 0;
      }

      if (period === "PM" && hour !== 12) {
        hour += 12;
      }

      return { hour, minute };
    }
  }

  return fallback;
}

function getTimeZoneParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });

  const parts: Record<string, string> = {};

  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") {
      parts[part.type] = part.value;
    }
  }

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function getTimeZoneOffsetMs(date: Date, timeZone: string) {
  const parts = getTimeZoneParts(date, timeZone);

  return (
    Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    ) - date.getTime()
  );
}

function makeDateFromZonedParts({
  dateKey,
  hour,
  minute,
  timeZone,
}: {
  dateKey: string;
  hour: number;
  minute: number;
  timeZone: string;
}) {
  const [yearRaw, monthRaw, dayRaw] = dateKey.split("-");
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const utcGuessMs = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const utcGuess = new Date(utcGuessMs);
  const offsetMs = getTimeZoneOffsetMs(utcGuess, timeZone);
  const adjustedDate = new Date(utcGuessMs - offsetMs);
  const adjustedOffsetMs = getTimeZoneOffsetMs(adjustedDate, timeZone);

  if (adjustedOffsetMs !== offsetMs) {
    return new Date(utcGuessMs - adjustedOffsetMs);
  }

  return adjustedDate;
}

function formatTimeForMetadata(time: { hour: number; minute: number }) {
  return `${String(time.hour).padStart(2, "0")}:${String(time.minute).padStart(
    2,
    "0"
  )}`;
}

function buildPropertyStayDateRange({
  checkInDateKey,
  checkOutDateKey,
  propertyCheckInTime,
  propertyCheckOutTime,
  propertyTimeZone,
}: {
  checkInDateKey: string;
  checkOutDateKey: string;
  propertyCheckInTime?: unknown;
  propertyCheckOutTime?: unknown;
  propertyTimeZone?: unknown;
}) {
  const timeZone = normalizePropertyTimeZone(propertyTimeZone);
  const checkInTime = parsePropertyTime(propertyCheckInTime, {
    hour: 16,
    minute: 0,
  });
  const checkOutTime = parsePropertyTime(propertyCheckOutTime, {
    hour: 11,
    minute: 0,
  });

  return {
    checkIn: makeDateFromZonedParts({
      dateKey: checkInDateKey,
      hour: checkInTime.hour,
      minute: checkInTime.minute,
      timeZone,
    }),
    checkOut: makeDateFromZonedParts({
      dateKey: checkOutDateKey,
      hour: checkOutTime.hour,
      minute: checkOutTime.minute,
      timeZone,
    }),
    timeZone,
    checkInTime: formatTimeForMetadata(checkInTime),
    checkOutTime: formatTimeForMetadata(checkOutTime),
  };
}

function getDirectBookingPlatformFeeCents(totalAmountCents: number) {
  const percentRaw = Number(
    process.env.PINGO_DIRECT_BOOKING_PLATFORM_FEE_PERCENT ?? "0"
  );

  const fixedCentsRaw = Number(
    process.env.PINGO_DIRECT_BOOKING_PLATFORM_FEE_FIXED_CENTS ?? "0"
  );

  const percent = Number.isFinite(percentRaw) ? Math.max(0, percentRaw) : 0;
  const fixedCents = Number.isFinite(fixedCentsRaw)
    ? Math.max(0, Math.round(fixedCentsRaw))
    : 0;

  const percentFeeCents = Math.round(totalAmountCents * (percent / 100));
  const feeCents = percentFeeCents + fixedCents;

  return Math.min(Math.max(0, feeCents), totalAmountCents);
}

function getIdentityCheckFeeCents() {
  const rawAmount = Number(
    process.env.DIRECT_BOOKING_PROTECTION_FEE_AMOUNT ?? "2.50"
  );

  if (!Number.isFinite(rawAmount) || rawAmount < 0) {
    throw new Error("DIRECT_BOOKING_PROTECTION_FEE_AMOUNT_INVALID");
  }

  return Math.round(rawAmount * 100);
}

function toMoneyFromCents(cents: number) {
  return Number((cents / 100).toFixed(2));
}

function toStripeMetadataValue(value: string, maxLength = 500) {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function isGuestCancellationRouteError(error: any) {
  return (
    error &&
    typeof error === "object" &&
    error.name === "GuestCancellationError" &&
    typeof error.code === "string" &&
    typeof error.statusCode === "number"
  );
}

function sendGuestCancellationRouteError({
  res,
  error,
  fallbackMessage,
  logLabel,
}: {
  res: any;
  error: any;
  fallbackMessage: string;
  logLabel: string;
}) {
  console.error(logLabel, error?.message ?? error);

  if (isGuestCancellationRouteError(error)) {
    return res.status(error.statusCode).json({
      ok: false,
      error: error.code,
      message: error.message,
      details: error.details ?? null,
    });
  }

  return res.status(500).json({
    ok: false,
    error: fallbackMessage,
  });
}

function isGuestReservationModificationRouteError(error: any) {
  return (
    error &&
    typeof error === "object" &&
    error.name === "GuestReservationModificationError" &&
    typeof error.code === "string" &&
    typeof error.statusCode === "number"
  );
}

function sendGuestReservationModificationRouteError({
  res,
  error,
  fallbackMessage,
  logLabel,
}: {
  res: any;
  error: any;
  fallbackMessage: string;
  logLabel: string;
}) {
  console.error(logLabel, error?.message ?? error);

  if (isGuestReservationModificationRouteError(error)) {
    return res.status(error.statusCode).json({
      ok: false,
      error: error.code,
      message: error.message,
      details: error.details ?? null,
    });
  }

  return res.status(500).json({
    ok: false,
    error: fallbackMessage,
  });
}

publicBookingRouter.get(
  "/manage/:guestToken/modification-options",
  async (req, res) => {
    try {
      const guestToken = String(req.params.guestToken ?? "").trim();
      const options = await getGuestReservationModificationOptions({
        guestToken,
      });

      return res.json({
        ok: true,
        ...options,
      });
    } catch (error: any) {
      return sendGuestReservationModificationRouteError({
        res,
        error,
        fallbackMessage: "Failed to load reservation modification options.",
        logLabel: "[public-booking modification-options error]",
      });
    }
  }
);

publicBookingRouter.post(
  "/manage/:guestToken/modification-preview",
  async (req, res) => {
    try {
      const guestToken = String(req.params.guestToken ?? "").trim();
      const checkInDateKey = parseDateKey(req.body?.checkIn);
      const checkOutDateKey = parseDateKey(req.body?.checkOut);

      if (!checkInDateKey || !checkOutDateKey) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_STAY_DATES",
          message: "Missing or invalid check-in/check-out dates.",
        });
      }

      if (!Array.isArray(req.body?.selectedAmenityIds)) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_SELECTED_AMENITIES",
          message: "selectedAmenityIds must be an array.",
        });
      }

      const options = await getGuestReservationModificationOptions({
        guestToken,
      });
      const stayDates = buildPropertyStayDateRange({
        checkInDateKey,
        checkOutDateKey,
        propertyCheckInTime: options.property.checkInTime,
        propertyCheckOutTime: options.property.checkOutTime,
        propertyTimeZone: options.property.timezone,
      });
      const preview = await getGuestReservationModificationPreview({
        guestToken,
        checkIn: stayDates.checkIn,
        checkOut: stayDates.checkOut,
        adults: Number(req.body?.adults),
        children: Number(req.body?.children),
        selectedAmenityIds: req.body.selectedAmenityIds,
      });

      return res.json({
        ok: true,
        ...preview,
      });
    } catch (error: any) {
      return sendGuestReservationModificationRouteError({
        res,
        error,
        fallbackMessage: "Failed to preview reservation modification.",
        logLabel: "[public-booking modification-preview error]",
      });
    }
  }
);

publicBookingRouter.post(
  "/manage/:guestToken/modification-confirm",
  async (req, res) => {
    try {
      const guestToken = String(req.params.guestToken ?? "").trim();
      const checkInDateKey = parseDateKey(req.body?.checkIn);
      const checkOutDateKey = parseDateKey(req.body?.checkOut);

      if (!checkInDateKey || !checkOutDateKey) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_STAY_DATES",
          message: "Missing or invalid check-in/check-out dates.",
        });
      }

      if (!Array.isArray(req.body?.selectedAmenityIds)) {
        return res.status(400).json({
          ok: false,
          error: "INVALID_SELECTED_AMENITIES",
          message: "selectedAmenityIds must be an array.",
        });
      }

      const options = await getGuestReservationModificationOptions({
        guestToken,
      });
      const stayDates = buildPropertyStayDateRange({
        checkInDateKey,
        checkOutDateKey,
        propertyCheckInTime: options.property.checkInTime,
        propertyCheckOutTime: options.property.checkOutTime,
        propertyTimeZone: options.property.timezone,
      });
      const result = await confirmGuestReservationModification({
        guestToken,
        clientRequestId: String(req.body?.clientRequestId ?? "").trim(),
        checkIn: stayDates.checkIn,
        checkOut: stayDates.checkOut,
        adults: Number(req.body?.adults),
        children: Number(req.body?.children),
        selectedAmenityIds: req.body.selectedAmenityIds,
        acceptNoRefundReduction:
          req.body?.acceptNoRefundReduction === true,
      });

      if (
        result.modification.status ===
        ReservationModificationStatus.APPLYING
      ) {
        const applied = await applyGuestReservationModification({
          modificationId: result.modification.id,
        });

        return res.json({
          ...result,
          idempotentReplay:
            result.idempotentReplay || applied.idempotentReplay,
          datesChanged: applied.datesChanged,
          ariIntentCreated: applied.ariIntentCreated,
          modification: {
            ...result.modification,
            ...applied.modification,
            nextAction: "NONE",
          },
          reservation: applied.reservation,
        });
      }

      return res.json(result);
    } catch (error: any) {
      return sendGuestReservationModificationRouteError({
        res,
        error,
        fallbackMessage: "Failed to confirm reservation modification.",
        logLabel: "[public-booking modification-confirm error]",
      });
    }
  }
);

publicBookingRouter.post(
  "/manage/:guestToken/modification-checkout",
  async (req, res) => {
    try {
      const guestToken = String(req.params.guestToken ?? "").trim();
      const modificationId = String(
        req.body?.modificationId ?? ""
      ).trim();
      const result = await createGuestReservationModificationCheckout({
        guestToken,
        modificationId,
      });

      return res.json(result);
    } catch (error: any) {
      return sendGuestReservationModificationRouteError({
        res,
        error,
        fallbackMessage:
          "Failed to create reservation modification payment Checkout.",
        logLabel: "[public-booking modification-checkout error]",
      });
    }
  }
);

publicBookingRouter.get(
  "/manage/:guestToken/cancellation-preview",
  async (req, res) => {
    try {
      const guestToken = String(req.params.guestToken ?? "").trim();

      const preview = await getGuestCancellationPreview({
        guestToken,
      });

      return res.json({
        ok: true,
        ...preview,
      });
    } catch (error: any) {
      return sendGuestCancellationRouteError({
        res,
        error,
        fallbackMessage: "Failed to load cancellation preview.",
        logLabel: "[public-booking cancellation-preview error]",
      });
    }
  }
);

publicBookingRouter.post("/manage/:guestToken/cancel", async (req, res) => {
  try {
    const guestToken = String(req.params.guestToken ?? "").trim();
    const reason =
      typeof req.body?.reason === "string" ? req.body.reason : null;

    const result = await cancelReservationFromGuestPortal({
      guestToken,
      reason,
    });

    return res.json(result);
  } catch (error: any) {
    return sendGuestCancellationRouteError({
      res,
      error,
      fallbackMessage: "Failed to cancel reservation.",
      logLabel: "[public-booking guest-cancel error]",
    });
  }
});

publicBookingRouter.get("/:organizationSlug", async (req, res) => {
  try {
    const organizationSlug = String(req.params.organizationSlug ?? "").trim();

    if (!organizationSlug) {
      return res.status(400).json({ ok: false, error: "Missing organizationSlug" });
    }

    const organization = await prisma.organization.findFirst({
      where: {
        slug: organizationSlug,
        publicBookingEnabled: true,
      },
      select: {
        id: true,
        name: true,
        slug: true,
        properties: {
          where: {
            status: "ACTIVE",
            isPublicBookable: true,
          },
          select: {
            id: true,
            name: true,
            slug: true,
            publicTitle: true,
            publicDescription: true,
            publicDescriptionEs: true,
            publicPhotos: true,
            baseNightlyRate: true,
            cleaningFee: true,
            amenities: {
              where: { isActive: true },
              orderBy: { name: "asc" },
              select: {
              id: true,
              name: true,
              description: true,
              chargeMode: true,
              feeType: true,
              amount: true,
           },
         },
            taxes: {
              where: { isActive: true },
              orderBy: { name: "asc" },
              select: {
              id: true,
              name: true,
              percentage: true,
           },
         },
            maxGuests: true,
            minimumNights: true,
            maximumNights: true,
            city: true,
            region: true,
            country: true,
            checkInTime: true,
            checkOutTime: true,
            timezone: true,
          },
          orderBy: {
            name: "asc",
          },
        },
      },
    });

    if (!organization) {
      return res.status(404).json({ ok: false, error: "Public booking site not found" });
    }

    const publicBrand = await resolvePublicBookingBrandContext(organization.id);

    return res.json({ ok: true, organization, publicBrand });
  } catch (error: any) {
    console.error("[public-booking list error]", error?.message ?? error);
    return res.status(500).json({ ok: false, error: "Failed to load booking site" });
  }
});

publicBookingRouter.get("/:organizationSlug/:propertySlug", async (req, res) => {
  try {
    const organizationSlug = String(req.params.organizationSlug ?? "").trim();
    const propertySlug = String(req.params.propertySlug ?? "").trim();

    if (!organizationSlug || !propertySlug) {
      return res.status(400).json({ ok: false, error: "Missing organizationSlug/propertySlug" });
    }

    const property = await prisma.property.findFirst({
      where: {
        slug: propertySlug,
        status: "ACTIVE",
        isPublicBookable: true,
        organization: {
          slug: organizationSlug,
          publicBookingEnabled: true,
        },
      },
      select: {
        id: true,
        organizationId: true,
        name: true,
        slug: true,
        publicTitle: true,
        publicDescription: true,
        publicDescriptionEs: true,
        publicPhotos: true,
        baseNightlyRate: true,
        cleaningFee: true,
        amenities: {
          where: { isActive: true },
          orderBy: { name: "asc" },
          select: {
            id: true,
            name: true,
            description: true,
            chargeMode: true,
            feeType: true,
            amount: true,
          },
        },
       taxes: {
         where: { isActive: true },
         orderBy: { name: "asc" },
         select: {
         id: true,
         name: true,
         percentage: true,
          },
        },
        maxGuests: true,
        minimumNights: true,
        maximumNights: true,
        city: true,
        region: true,
        country: true,
        checkInTime: true,
        checkOutTime: true,
        timezone: true,
        organization: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
      },
    });

   if (!property) {
  return res.status(404).json({ ok: false, error: "Public property not found" });
}

const cancellationPolicy =
  await buildCancellationPolicySnapshot(property.id);

const activeGuestAgreement =
  await getActivePropertyGuestAgreement(
    prisma,
    property.id
  );

const organizationContact =
  await resolveOrganizationGuestReplyTo(
    prisma,
    property.organizationId
  );

const preferredLanguage =
  String(req.query.lang ?? "")
    .trim()
    .toLowerCase() === "es"
    ? "es"
    : "en";

const cancellationPolicyPresentation =
  renderCancellationPolicySnapshot({
    snapshot: cancellationPolicy,
    preferredLanguage,
  });

const publicBrand = await resolvePublicBookingBrandContext(
  property.organizationId
);

return res.json({
  ok: true,
  publicBrand,
  property: {
    ...property,
    cancellationPolicy,
    cancellationPolicyPresentation,
    guestAccessSettings: {
      configured: Boolean(activeGuestAgreement),
      requiresIdentityVerification:
        activeGuestAgreement
          ?.requiresIdentityVerification ?? true,
    },
    organization: {
      ...property.organization,
      contactEmail: organizationContact.email,
    },
  },
});
  } catch (error: any) {
    console.error("[public-booking property error]", error?.message ?? error);
    return res.status(500).json({ ok: false, error: "Failed to load property" });
  }
});

publicBookingRouter.post("/blocked-dates", async (req, res) => {
  try {
    const { propertyId, from, to } = req.body ?? {};

    const start = parseDate(from);
    const end = parseDate(to);

    if (!propertyId || !start || !end) {
      return res.status(400).json({
        ok: false,
        error: "Missing or invalid propertyId/from/to",
      });
    }

    const property = await prisma.property.findFirst({
      where: {
        id: String(propertyId),
        status: "ACTIVE",
        isPublicBookable: true,
        organization: {
          publicBookingEnabled: true,
        },
      },
      select: {
        id: true,
      },
    });

    if (!property) {
      return res.status(404).json({
        ok: false,
        error: "Property not available for public booking",
      });
    }

    const result = await getPropertyBlockedDateKeys({
      propertyId: property.id,
      from: start,
      to: end,
    });

    return res.json({
      ok: true,
      blockedDates: result.blockedDates,
    });
  } catch (error: any) {
    console.error("[public-booking blocked-dates error]", error?.message ?? error);
    return res.status(500).json({
      ok: false,
      error: "Failed to load blocked dates",
    });
  }
});

publicBookingRouter.post("/check-availability", async (req, res) => {
  try {
    const { propertyId, checkIn, checkOut } = req.body ?? {};
    const checkInDateKey = parseDateKey(checkIn);
    const checkOutDateKey = parseDateKey(checkOut);

    if (!propertyId || !checkInDateKey || !checkOutDateKey) {
      return res.status(400).json({
        ok: false,
        error: "Missing or invalid propertyId/checkIn/checkOut",
      });
    }

    const property = await prisma.property.findFirst({
      where: {
        id: String(propertyId),
        status: "ACTIVE",
        isPublicBookable: true,
        organization: {
          publicBookingEnabled: true,
        },
      },
      select: {
        id: true,
        checkInTime: true,
        checkOutTime: true,
        timezone: true,
      },
    });

    if (!property) {
      return res.status(404).json({ ok: false, error: "Property not available for public booking" });
    }

    const stayDates = buildPropertyStayDateRange({
      checkInDateKey,
      checkOutDateKey,
      propertyCheckInTime: property.checkInTime,
      propertyCheckOutTime: property.checkOutTime,
      propertyTimeZone: property.timezone,
    });

    if (stayDates.checkIn >= stayDates.checkOut) {
      return res.status(400).json({
        ok: false,
        error: "Check-out must be after check-in",
      });
    }

    const availability = await checkPropertyAvailability({
      propertyId: property.id,
      checkIn: stayDates.checkIn,
      checkOut: stayDates.checkOut,
    });

    return res.json({
      ok: true,
      available: availability.available,
      conflict: availability.conflict,
      checkIn: stayDates.checkIn.toISOString(),
      checkOut: stayDates.checkOut.toISOString(),
      timezone: stayDates.timeZone,
      checkInTime: stayDates.checkInTime,
      checkOutTime: stayDates.checkOutTime,
    });
  } catch (error: any) {
    console.error("[public-booking availability error]", error?.message ?? error);
    return res.status(500).json({ ok: false, error: "Failed to check availability" });
  }
});

publicBookingRouter.post("/quote", async (req, res) => {
  try {
    const { propertyId, checkIn, checkOut, selectedAmenityIds } = req.body ?? {};
    const checkInDateKey = parseDateKey(checkIn);
    const checkOutDateKey = parseDateKey(checkOut);

    if (!propertyId || !checkInDateKey || !checkOutDateKey) {
      return res.status(400).json({
        ok: false,
        error: "Invalid quote request",
      });
    }

    const property = await prisma.property.findFirst({
      where: {
        id: String(propertyId),
        status: "ACTIVE",
        isPublicBookable: true,
        organization: {
          publicBookingEnabled: true,
        },
      },
      select: {
        id: true,
        checkInTime: true,
        checkOutTime: true,
        timezone: true,
      },
    });

    if (!property) {
      return res.status(404).json({
        ok: false,
        error: "Property not available for public booking",
      });
    }

    const stayDates = buildPropertyStayDateRange({
      checkInDateKey,
      checkOutDateKey,
      propertyCheckInTime: property.checkInTime,
      propertyCheckOutTime: property.checkOutTime,
      propertyTimeZone: property.timezone,
    });

    if (stayDates.checkIn >= stayDates.checkOut) {
      return res.status(400).json({
        ok: false,
        error: "Invalid quote request",
      });
    }

    const pricing = await calculateDirectBookingPricing({
      propertyId: property.id,
      checkIn: stayDates.checkIn,
      checkOut: stayDates.checkOut,
      selectedAmenityIds: Array.isArray(selectedAmenityIds)
        ? selectedAmenityIds.map((id) => String(id)).filter(Boolean)
        : [],
    });

    return res.json({
      ok: true,
      pricing,
      checkIn: stayDates.checkIn.toISOString(),
      checkOut: stayDates.checkOut.toISOString(),
      timezone: stayDates.timeZone,
      checkInTime: stayDates.checkInTime,
      checkOutTime: stayDates.checkOutTime,
    });
  } catch (err) {
    console.error("public booking quote error", err);
    return res.status(500).json({
      ok: false,
      error: "Unable to calculate quote",
    });
  }
});

publicBookingRouter.post("/create-checkout", async (req, res) => {
  try {
   const {
   propertyId,
   checkIn,
   checkOut,
   guestName,
   guestEmail,
   guestPhone,
   preferredLanguage,
   stayNotificationsConsent,
   guestAcceptedCancellationTerms,
   guestAcceptedSecurePreCheckinRequirement,
   adults,
   children,
   selectedAmenityIds,
} = req.body ?? {};    
    
    const normalizedPreferredLanguage =
      String(preferredLanguage ?? "")
        .trim()
        .toLowerCase() === "es"
        ? "es"
        : "en";
   
    const adultsCount = Number(adults ?? 1);
    const childrenCount = Number(children ?? 0);
    const totalGuests = adultsCount + childrenCount;

    if (
      !Number.isInteger(adultsCount) ||
      !Number.isInteger(childrenCount) ||
      adultsCount < 1 ||
      childrenCount < 0 ||
      totalGuests < 1
    ) {
      return res.status(400).json({
        ok: false,
        error: "Invalid guest count",
      });
    }
 
    const checkInDateKey = parseDateKey(checkIn);
    const checkOutDateKey = parseDateKey(checkOut);

    if (!propertyId || !checkInDateKey || !checkOutDateKey || !guestName || !guestEmail) {
      return res.status(400).json({
        ok: false,
        error: "Missing or invalid propertyId/checkIn/checkOut/guestName/guestEmail",
      });
    }

if (guestAcceptedCancellationTerms !== true) {
  return res.status(400).json({
    ok: false,
    error: "Cancellation terms acknowledgment is required.",
  });
}

if (guestAcceptedSecurePreCheckinRequirement !== true) {
  return res.status(400).json({
    ok: false,
    error:
      "Secure Pre-check-in requirement acknowledgment is required.",
  });
}
    const property = await prisma.property.findFirst({
      where: {
        id: String(propertyId),
        status: "ACTIVE",
        isPublicBookable: true,
        organization: {
          publicBookingEnabled: true,
        },
      },
      select: {
        id: true,
        organizationId: true,
        name: true,
        publicTitle: true,
        baseNightlyRate: true,
        cleaningFee: true,
        maxGuests: true,
        minimumNights: true,
        maximumNights: true,
        checkInTime: true,
        checkOutTime: true,
        timezone: true,
        organization: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
      },
    });

    if (!property) {
      return res.status(404).json({
        ok: false,
        error: "Property not available for public booking",
      });
    }

    if (!property.baseNightlyRate) {
      return res.status(400).json({
        ok: false,
        error: "Property is missing baseNightlyRate",
      });
    }

if (property.maxGuests && totalGuests > property.maxGuests) {
  return res.status(400).json({
    ok: false,
    error: `Maximum guests allowed is ${property.maxGuests}`,
  });
}

const stayDates = buildPropertyStayDateRange({
  checkInDateKey,
  checkOutDateKey,
  propertyCheckInTime: property.checkInTime,
  propertyCheckOutTime: property.checkOutTime,
  propertyTimeZone: property.timezone,
});

if (stayDates.checkIn >= stayDates.checkOut) {
  return res.status(400).json({
    ok: false,
    error: "Check-out must be after check-in",
  });
}

    const availability = await checkPropertyAvailability({
      propertyId: property.id,
      checkIn: stayDates.checkIn,
      checkOut: stayDates.checkOut,
    });

    if (!availability.available) {
      return res.status(409).json({
        ok: false,
        error: "Property is not available for the selected dates",
        conflict: availability.conflict,
      });
    }

    const nights = Math.ceil(
      (stayDates.checkOut.getTime() - stayDates.checkIn.getTime()) / (1000 * 60 * 60 * 24)
    );

    if (!Number.isFinite(nights) || nights <= 0) {
      return res.status(400).json({
        ok: false,
        error: "Invalid number of nights",
      });
    }

if (nights < (property.minimumNights ?? 1)) {
  return res.status(400).json({
    ok: false,
    error: `Minimum stay is ${property.minimumNights} night(s)`,
  });
}

if (
  property.maximumNights &&
  nights > property.maximumNights
) {
  return res.status(400).json({
    ok: false,
    error: `Maximum stay is ${property.maximumNights} night(s)`,
  });
}

const cleanSelectedAmenityIds = Array.isArray(selectedAmenityIds)
  ? selectedAmenityIds.map((id) => String(id)).filter(Boolean)
  : [];

const pricing = await calculateDirectBookingPricing({
  propertyId: property.id,
  checkIn: stayDates.checkIn,
  checkOut: stayDates.checkOut,
  selectedAmenityIds: cleanSelectedAmenityIds,
});

const totalAmount = pricing.totalAmount;
const totalAmountCents = pricing.totalAmountCents;

    if (!Number.isFinite(totalAmountCents) || totalAmountCents <= 0) {
      return res.status(400).json({
        ok: false,
        error: "Invalid booking amount",
      });
    }

    const cancellationPolicySnapshot =
      await buildCancellationPolicySnapshot(property.id);

    const activeGuestAgreement =
      await getActivePropertyGuestAgreement(prisma, property.id);

    if (!activeGuestAgreement) {
      return res.status(409).json({
        ok: false,
        error: "GUEST_ACCESS_SETTINGS_NOT_CONFIGURED",
        message:
          "Secure Guest Access must be configured before this property can accept Direct Booking payments.",
      });
    }

    const identityVerificationRequired =
      activeGuestAgreement.requiresIdentityVerification;

   const guestAcceptedCancellationTermsAt = new Date().toISOString();
   const guestAcceptedCancellationTermsText =
     buildGuestCancellationTermsText(
       cancellationPolicySnapshot,
       normalizedPreferredLanguage
     );

const guestAcceptedSecurePreCheckinRequirementAt =
  new Date().toISOString();

const guestAcceptedSecurePreCheckinRequirementText =
  buildSecurePrecheckinDisclosureText(
    identityVerificationRequired
  );
    const cancellationPolicySnapshotWithGuestAcceptance = {
      ...cancellationPolicySnapshot,
      guestAcceptedCancellationTerms: true,
      guestAcceptedCancellationTermsAt,
      guestAcceptedCancellationTermsText,
    };

    const cancellationPolicyMetadata =
      serializeCancellationPolicySnapshotForStripeMetadata(
        cancellationPolicySnapshotWithGuestAcceptance
      );

    let connectedAccountId: string;
    try {
      const payoutReady = await assertDirectBookingPayoutReady(
        property.organizationId
      );

      connectedAccountId = payoutReady.connectedAccountId;
    } catch (error: any) {
      if (
        error?.code === "HOST_PAYOUT_NOT_READY" ||
        error?.statusCode === 409
      ) {
        return res.status(409).json({
          ok: false,
          error: error?.code || "HOST_PAYOUT_NOT_READY",
          message:
            error?.message ||
            "Host payout setup is not ready for Direct Booking payments.",
          payoutStatus: error?.details,
        });
      }

      throw error;
    }

    const basePlatformFeeAmountCents =
      getDirectBookingPlatformFeeCents(totalAmountCents);
    const connectFee = calculateDirectBookingConnectFee({
      totalAmountCents,
      basePlatformFeeAmountCents,
      identityCheckFeeAmountCents: identityVerificationRequired
        ? getIdentityCheckFeeCents()
        : 0,
    });
    const directBookingProtectionFeeAmountCents =
      connectFee.identityCheckFeeAmountCents;
    const platformFeeAmountCents = connectFee.platformFeeAmountCents;
    const hostPayoutAmountCents = connectFee.hostPayoutAmountCents;

    const basePlatformFeeAmount = toMoneyFromCents(
      basePlatformFeeAmountCents
    );
    const directBookingProtectionFeeAmount = toMoneyFromCents(
      directBookingProtectionFeeAmountCents
    );
    const platformFeeAmount = toMoneyFromCents(platformFeeAmountCents);
    const hostPayoutAmount = toMoneyFromCents(hostPayoutAmountCents);

    const paymentIntentData: any = {
      transfer_data: {
        destination: connectedAccountId,
      },
    };

    if (platformFeeAmountCents > 0) {
      paymentIntentData.application_fee_amount = platformFeeAmountCents;
    }

    const APP_URL = process.env.APP_URL ?? "http://localhost:3000";

    const session = await stripe.checkout.sessions.create({
  mode: "payment",
  locale: normalizedPreferredLanguage,
  customer_email: String(guestEmail).trim(),
  payment_intent_data: paymentIntentData,
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `${property.publicTitle ?? property.name}`,
              description: `${nights} night(s) + cleaning fee`,
            },
            unit_amount: totalAmountCents,
          },
          quantity: 1,
        },
      ],
      success_url:
        `${APP_URL}/booking/success?organization=${encodeURIComponent(
          property.organization.slug
        )}&identityCheck=${
          identityVerificationRequired
            ? "required"
            : "optional"
        }`,
      cancel_url: `${APP_URL}/booking/cancel?organization=${property.organization.slug}`,
      metadata: {
        flow: "direct_booking",
        preferredLanguage: normalizedPreferredLanguage,
        organizationId: property.organizationId,
        propertyId: property.id,
        checkIn: stayDates.checkIn.toISOString(),
        checkOut: stayDates.checkOut.toISOString(),
        propertyTimezone: stayDates.timeZone,
        propertyCheckInTime: stayDates.checkInTime,
        propertyCheckOutTime: stayDates.checkOutTime,
        guestName: String(guestName).trim(),
        guestEmail: String(guestEmail).trim(),
        guestPhone: guestPhone ? String(guestPhone).trim() : "",
        stayNotificationsConsent: String(stayNotificationsConsent === true),
        consentSource: "DIRECT_BOOKING_WEB_FORM",
        consentVersion: "stay_notifications_v1",

        securePrecheckinAccepted: "true",
        securePrecheckinAcceptedAt: guestAcceptedSecurePreCheckinRequirementAt,
        securePrecheckinText: toStripeMetadataValue(
          guestAcceptedSecurePreCheckinRequirementText
        ),
        securePrecheckinVersion: SECURE_PRECHECKIN_DISCLOSURE_VERSION,
        securePrecheckinSource: SECURE_PRECHECKIN_DISCLOSURE_SOURCE,
        adults: String(adultsCount),
        children: String(childrenCount),
        totalGuests: String(totalGuests),
        nights: String(nights),
        nightlyRate: String(pricing.nightlyRate),
        cleaningFee: String(pricing.cleaningFee),
        amenitiesTotal: String(pricing.amenitiesTotal),
        selectedAmenityIds: JSON.stringify(cleanSelectedAmenityIds),
        taxesTotal: String(pricing.taxesTotal),
        totalAmount: String(pricing.totalAmount),
        
        stripeConnectedAccountId: connectedAccountId,
        basePlatformFeeAmount: String(basePlatformFeeAmount),
        directBookingProtectionFeeAmount: String(
          directBookingProtectionFeeAmount
        ),
        identityVerificationRequired: String(identityVerificationRequired),
        platformFeeAmount: String(platformFeeAmount),
        hostPayoutAmount: String(hostPayoutAmount),
        hostPayoutStatus: "ROUTED_TO_CONNECT",
        guestAcceptedCancellationTerms: "true",
        guestAcceptedCancellationTermsAt,
        guestAcceptedCancellationTermsText: toStripeMetadataValue(
          guestAcceptedCancellationTermsText
        ),
        guestAcceptedCancellationTermsSource: "DIRECT_BOOKING_WEB_FORM",
        cancellationTermsAckVersion: "cancellation_terms_ack_v1",
        cancellationPolicyRefundBasis: String(
          cancellationPolicySnapshot.refundBasis ?? ""
        ),
        cancellationPolicySnapshot: cancellationPolicyMetadata,
        cancellationPolicyId: cancellationPolicySnapshot.policyId ?? "",
        cancellationPolicyName: cancellationPolicySnapshot.name.slice(0, 100),
        cancellationPolicyType: cancellationPolicySnapshot.type,
        freeCancellationHoursBeforeCheckIn: String(
          cancellationPolicySnapshot.freeCancellationHoursBeforeCheckIn
        ),
        refundPercentBeforeDeadline: String(
          cancellationPolicySnapshot.refundPercentBeforeDeadline
        ),
        refundPercentAfterDeadline: String(
          cancellationPolicySnapshot.refundPercentAfterDeadline
        ),
      },
    });

    return res.json({
      ok: true,
      checkoutUrl: session.url,
      sessionId: session.id,
     totalAmount: pricing.totalAmount,
     currency: pricing.currency,
     nights: pricing.nights,
     checkIn: stayDates.checkIn.toISOString(),
     checkOut: stayDates.checkOut.toISOString(),
     timezone: stayDates.timeZone,
     checkInTime: stayDates.checkInTime,
     checkOutTime: stayDates.checkOutTime,
     pricing, 
    });
  } catch (error: any) {
    console.error("[public-booking create-checkout error]", error?.message ?? error);
    return res.status(500).json({
      ok: false,
      error: error?.message ?? "Failed to create checkout",
    });
  }
});
export default publicBookingRouter;
