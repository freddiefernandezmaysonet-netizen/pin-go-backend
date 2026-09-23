import { z } from "zod";

const Permission = z.enum(["ALLOWED", "NOT_ALLOWED", "UNKNOWN"]).default("UNKNOWN");
const Truth = z.enum(["YES", "NO", "UNKNOWN"]).default("UNKNOWN");
const NullableText = z.string().trim().max(2000).nullable().optional().transform((v) => v || null);
const Count = z.number().int().min(0).max(100).nullable().optional().default(null);
const Time = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/).nullable().optional().default(null);

const Bed = z.object({
  type: z.enum(["KING", "QUEEN", "DOUBLE", "SINGLE", "BUNK", "SOFA_BED", "FUTON", "CRIB", "OTHER"]),
  quantity: z.number().int().min(1).max(20),
}).strict();

const SleepingArea = z.object({
  kind: z.enum(["BEDROOM", "SLEEPING_AREA"]).default("BEDROOM"),
  nameEn: z.string().trim().max(200).nullable().optional().default(null),
  nameEs: z.string().trim().max(200).nullable().optional().default(null),
  sortOrder: z.number().int().min(0).max(1000).default(0),
  beds: z.array(Bed).max(20).default([]),
}).strict();

const SharedSpace = z.object({
  type: z.enum(["POOL", "HOT_TUB", "KITCHEN", "PATIO", "YARD", "LIVING_ROOM", "LAUNDRY", "OTHER"]),
  labelEn: z.string().trim().max(200).nullable().optional().default(null),
  labelEs: z.string().trim().max(200).nullable().optional().default(null),
  sortOrder: z.number().int().min(0).max(1000).default(0),
}).strict();

const SafetyConsideration = z.object({
  type: z.enum(["POOL", "HOT_TUB", "WATERFRONT", "HEIGHTS", "STAIRS", "OTHER"]),
  descriptionEn: NullableText,
  descriptionEs: NullableText,
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(1000).default(0),
}).strict();

const AdditionalConsideration = z.object({
  titleEn: z.string().trim().max(200).nullable().optional().default(null),
  titleEs: z.string().trim().max(200).nullable().optional().default(null),
  descriptionEn: NullableText,
  descriptionEs: NullableText,
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(1000).default(0),
}).strict().superRefine((value, ctx) => {
  if (!value.titleEn && !value.titleEs && !value.descriptionEn && !value.descriptionEs) {
    ctx.addIssue({ code: "custom", message: "consideration requires a title or description" });
  }
});

export const PropertyListingDetailsInputSchema = z.object({
  accommodationType: z.enum(["ENTIRE_PLACE", "PRIVATE_ROOM", "SHARED_ROOM"]).nullable().optional().default(null),
  bedroomCount: Count,
  fullBathroomCount: Count,
  halfBathroomCount: Count,
  minimumPrimaryBookingGuestAge: z.number().int().min(18).max(99).nullable().optional().default(null),
  childrenPolicy: Permission,
  infantsPolicy: Permission,
  adultsOnly: Truth,
  petsPolicy: Permission,
  smokingPolicy: Permission,
  vapingPolicy: Permission,
  eventsPolicy: Permission,
  unregisteredVisitorsPolicy: Permission,
  quietHoursEnabled: Truth,
  quietHoursStart: Time,
  quietHoursEnd: Time,
  parkingAvailability: Truth,
  parkingType: z.enum(["PRIVATE", "GARAGE", "DRIVEWAY", "STREET", "LOT", "OTHER"]).nullable().optional().default(null),
  parkingFeeType: z.enum(["FREE", "PAID", "UNKNOWN"]).nullable().optional().default(null),
  parkingVehicleCapacity: Count,
  smokeDetector: Truth,
  carbonMonoxideDetector: Truth,
  exteriorSecurityCameras: Truth,
  exteriorSecurityCamerasDisclosureEn: NullableText,
  exteriorSecurityCamerasDisclosureEs: NullableText,
  animalsOnProperty: Truth,
  animalsOnPropertyDisclosureEn: NullableText,
  animalsOnPropertyDisclosureEs: NullableText,
  stepFreeEntrance: Truth,
  entranceStepCount: z.number().int().min(0).max(1000).nullable().optional().default(null),
  elevatorAvailable: Truth,
  accessibleParking: Truth,
  stepFreeBedroomAccess: Truth,
  stepFreeBathroomAccess: Truth,
  stepFreeShower: Truth,
  sleepingAreas: z.array(SleepingArea).max(100).default([]),
  sharedSpaces: z.array(SharedSpace).max(100).default([]),
  safetyConsiderations: z.array(SafetyConsideration).max(100).default([]),
  additionalConsiderations: z.array(AdditionalConsideration).max(100).default([]),
}).strict().superRefine((value, ctx) => {
  if (value.adultsOnly === "YES" && value.childrenPolicy === "ALLOWED") {
    ctx.addIssue({ code: "custom", path: ["childrenPolicy"], message: "children cannot be ALLOWED when adultsOnly is YES" });
  }
  if (value.adultsOnly === "YES" && value.infantsPolicy === "ALLOWED") {
    ctx.addIssue({ code: "custom", path: ["infantsPolicy"], message: "infants cannot be ALLOWED when adultsOnly is YES" });
  }
  if (value.quietHoursEnabled === "YES" && (!value.quietHoursStart || !value.quietHoursEnd)) {
    ctx.addIssue({ code: "custom", path: ["quietHoursStart"], message: "quiet-hours start and end are required when enabled" });
  }
  if (value.parkingAvailability !== "YES" && (value.parkingType || value.parkingFeeType || value.parkingVehicleCapacity !== null)) {
    ctx.addIssue({ code: "custom", path: ["parkingAvailability"], message: "parking details require parkingAvailability YES" });
  }
  if (value.exteriorSecurityCameras === "YES" && !value.exteriorSecurityCamerasDisclosureEn && !value.exteriorSecurityCamerasDisclosureEs) {
    ctx.addIssue({ code: "custom", path: ["exteriorSecurityCameras"], message: "camera disclosure is required when cameras are present" });
  }
  if (value.animalsOnProperty === "YES" && !value.animalsOnPropertyDisclosureEn && !value.animalsOnPropertyDisclosureEs) {
    ctx.addIssue({ code: "custom", path: ["animalsOnProperty"], message: "animal disclosure is required when animals are present" });
  }
  if (value.stepFreeEntrance === "YES" && value.entranceStepCount !== null && value.entranceStepCount > 0) {
    ctx.addIssue({ code: "custom", path: ["entranceStepCount"], message: "step-free entrance cannot have a positive step count" });
  }
  if (value.bedroomCount !== null && value.sleepingAreas.length > 0) {
    const bedrooms = value.sleepingAreas.filter((area) => area.kind === "BEDROOM").length;
    if (bedrooms !== value.bedroomCount) {
      ctx.addIssue({ code: "custom", path: ["bedroomCount"], message: "bedroomCount must match BEDROOM sleeping areas when sleeping areas are supplied" });
    }
  }
});

export type PropertyListingDetailsInput = z.infer<typeof PropertyListingDetailsInputSchema>;

export class PropertyListingDetailsValidationError extends Error {
  readonly code = "PROPERTY_LISTING_DETAILS_INVALID";
  constructor(readonly issues: string[]) {
    super(issues[0] ?? "Property listing details are invalid");
    this.name = "PropertyListingDetailsValidationError";
  }
}

export function normalizePropertyListingDetailsInput(input: unknown): PropertyListingDetailsInput {
  const result = PropertyListingDetailsInputSchema.safeParse(input);
  if (!result.success) {
    throw new PropertyListingDetailsValidationError(
      result.error.issues.map((issue) => {
        const path = issue.path.length ? `${issue.path.join(".")}: ` : "";
        return `${path}${issue.message}`;
      })
    );
  }
  return result.data;
}
