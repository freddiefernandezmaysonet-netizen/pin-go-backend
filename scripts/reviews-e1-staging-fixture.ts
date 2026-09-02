import { prisma } from "../src/lib/prisma.js";
import { createReviewInvitation } from "../src/services/reviews/review.service.js";

const STAGING_PROJECT_ID = "c325f65b-f4a5-48a9-9270-376961eeba2d";
const FIXTURE_EMAIL = "reviews-certification@pin-go.invalid";
const ORGANIZATION_ID = "reviews_e1_staging_org";
const PROPERTY_ID = "reviews_e1_staging_property";
const RESERVATION_ID = "reviews_e1_staging_reservation";

function assertIsolatedStaging() {
  if (process.env.RAILWAY_PROJECT_ID !== STAGING_PROJECT_ID) {
    throw new Error("Reviews fixture refused: Railway project is not the isolated Reviews staging project.");
  }
  if (process.env.PINGO_REVIEWS_E1_STAGING_FIXTURE_ENABLED !== "true") {
    throw new Error("Reviews fixture refused: explicit staging fixture flag is disabled.");
  }
  if (process.env.PINGO_REVIEW_INVITATION_DISPATCH_ENABLED !== "false") {
    throw new Error("Reviews fixture refused: invitation dispatcher must remain disabled.");
  }
  if (!FIXTURE_EMAIL.endsWith(".invalid")) {
    throw new Error("Reviews fixture refused: recipient must use the reserved .invalid domain.");
  }
}

async function main() {
  assertIsolatedStaging();
  const now = new Date();
  const checkOut = new Date(now.getTime() - 24 * 60 * 60 * 1_000);
  const checkIn = new Date(checkOut.getTime() - 2 * 24 * 60 * 60 * 1_000);

  await prisma.organization.upsert({
    where: { id: ORGANIZATION_ID },
    update: { publicBookingEnabled: true },
    create: {
      id: ORGANIZATION_ID,
      name: "Pin&Go Reviews Certification",
      slug: "reviews-e1-certification",
      publicBookingEnabled: true,
    },
  });
  await prisma.property.upsert({
    where: { id: PROPERTY_ID },
    update: { isPublicBookable: true },
    create: {
      id: PROPERTY_ID,
      organizationId: ORGANIZATION_ID,
      name: "Staging Review Suite",
      publicTitle: "Staging Review Suite",
      slug: "staging-review-suite",
      isPublicBookable: true,
      timezone: "America/Puerto_Rico",
    },
  });
  await prisma.reservation.upsert({
    where: { id: RESERVATION_ID },
    update: {
      guestEmail: FIXTURE_EMAIL,
      checkIn,
      checkOut,
      status: "ACTIVE",
      cancelledAt: null,
      source: "DIRECT_BOOKING",
      externalProvider: "PIN_GO_DIRECT",
      paymentState: "PAID",
      amountCollected: 500,
    },
    create: {
      id: RESERVATION_ID,
      reservationNumber: "REVIEWS-E1-STAGING-001",
      propertyId: PROPERTY_ID,
      guestName: "Staging Guest",
      guestEmail: FIXTURE_EMAIL,
      preferredLanguage: "en",
      checkIn,
      checkOut,
      status: "ACTIVE",
      source: "DIRECT_BOOKING",
      externalProvider: "PIN_GO_DIRECT",
      externalId: "reviews-e1-staging-001",
      paymentState: "PAID",
      totalAmount: 500,
      amountCollected: 500,
      currency: "usd",
    },
  });

  const invitation = await createReviewInvitation(RESERVATION_ID, now);
  console.log(`REVIEWS_E1_STAGING_TOKEN=${invitation.token}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
