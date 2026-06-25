import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import {
  checkPropertyAvailability,
  getPropertyBlockedDateKeys,
} from "../services/availability.service";
import stripe from "../billing/stripe";
import { calculateDirectBookingPricing } from "../services/direct-booking-pricing.service";

const prisma = new PrismaClient();
const publicBookingRouter = Router();

function parseDate(value: unknown) {
  const date = new Date(String(value ?? ""));
  if (Number.isNaN(date.getTime())) return null;
  return date;
}

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

    return res.json({ ok: true, organization });
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
        address1: true,
        city: true,
        region: true,
        country: true,
        latitude: true,
        longitude: true,
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

    return res.json({ ok: true, property });
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

    const start = parseDate(checkIn);
    const end = parseDate(checkOut);

if (!propertyId || !start || !end) {
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
      },
    });

    if (!property) {
      return res.status(404).json({ ok: false, error: "Property not available for public booking" });
    }

    const availability = await checkPropertyAvailability({
      propertyId: property.id,
      checkIn: start,
      checkOut: end,
    });

    return res.json({
      ok: true,
      available: availability.available,
      conflict: availability.conflict,
    });
  } catch (error: any) {
    console.error("[public-booking availability error]", error?.message ?? error);
    return res.status(500).json({ ok: false, error: "Failed to check availability" });
  }
});

publicBookingRouter.post("/quote", async (req, res) => {
  try {
    const { propertyId, checkIn, checkOut, selectedAmenityIds } = req.body ?? {};

    const start = parseDate(checkIn);
    const end = parseDate(checkOut);

    if (!propertyId || !start || !end || start >= end) {
      return res.status(400).json({
        ok: false,
        error: "Invalid quote request",
      });
    }

    const pricing = await calculateDirectBookingPricing({
      propertyId: String(propertyId),
      checkIn: start,
      checkOut: end,
      selectedAmenityIds: Array.isArray(selectedAmenityIds)
        ? selectedAmenityIds.map((id) => String(id)).filter(Boolean)
        : [],
    });

    return res.json({
      ok: true,
      pricing,
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
   stayNotificationsConsent,
   adults,
   children,
   selectedAmenityIds,
} = req.body ?? {};    
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
 
    const start = parseDate(checkIn);
    const end = parseDate(checkOut);

    if (!propertyId || !start || !end || !guestName || !guestEmail) {
      return res.status(400).json({
        ok: false,
        error: "Missing or invalid propertyId/checkIn/checkOut/guestName/guestEmail",
      });
    }

    if (stayNotificationsConsent !== true) {
  return res.status(400).json({
    ok: false,
    error: "Stay notifications consent is required.",
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
        baseNightlyRate: true,
        cleaningFee: true,
        maxGuests: true,
        minimumNights: true,
        maximumNights: true,
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

    const availability = await checkPropertyAvailability({
      propertyId: property.id,
      checkIn: start,
      checkOut: end,
    });

    if (!availability.available) {
      return res.status(409).json({
        ok: false,
        error: "Property is not available for the selected dates",
        conflict: availability.conflict,
      });
    }

    const nights = Math.ceil(
      (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)
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
  checkIn: start,
  checkOut: end,
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

    const APP_URL = process.env.APP_URL ?? "http://localhost:3000";

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: String(guestEmail).trim(),
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
      success_url: `${APP_URL}/booking/success?organization=${property.organization.slug}`,
      cancel_url: `${APP_URL}/booking/cancel?organization=${property.organization.slug}`,
      metadata: {
        flow: "direct_booking",
        organizationId: property.organizationId,
        propertyId: property.id,
        checkIn: String(checkIn).slice(0, 10),
        checkOut: String(checkOut).slice(0, 10),
        guestName: String(guestName).trim(),
        guestEmail: String(guestEmail).trim(),
        guestPhone: guestPhone ? String(guestPhone).trim() : "",
        stayNotificationsConsent: "true",
        smsConsent: "true",
        consentSource: "DIRECT_BOOKING_WEB_FORM",
        consentVersion: "stay_notifications_v1",
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
      },
    });

    return res.json({
      ok: true,
      checkoutUrl: session.url,
      sessionId: session.id,
     totalAmount: pricing.totalAmount,
     currency: pricing.currency,
     nights: pricing.nights,
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