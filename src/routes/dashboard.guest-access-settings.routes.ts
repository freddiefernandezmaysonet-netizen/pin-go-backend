import { Router } from "express";
import {
  GuestAccessMode,
  Prisma,
  PrismaClient,
} from "@prisma/client";
import {
  requireAuth,
} from "../middleware/requireAuth";

const prisma = new PrismaClient();

export const dashboardGuestAccessSettingsRouter =
  Router();

function cleanRequiredText(
  value: unknown,
  field: string,
  minLength: number,
  maxLength: number
) {
  const text = String(value ?? "").trim();

  if (
    text.length < minLength ||
    text.length > maxLength
  ) {
    throw new Error(`${field}_INVALID`);
  }

  return text;
}

function cleanOptionalRequiredText(
  value: unknown,
  field: string,
  minLength: number,
  maxLength: number
) {
  if (
    value === undefined ||
    value === null ||
    String(value).trim() === ""
  ) {
    return null;
  }

  return cleanRequiredText(
    value,
    field,
    minLength,
    maxLength
  );
}

function cleanOptionalText(
  value: unknown,
  maxLength: number
) {
  if (
    value === undefined ||
    value === null ||
    String(value).trim() === ""
  ) {
    return null;
  }

  const text = String(value).trim();

  if (text.length > maxLength) {
    throw new Error(
      "GUEST_FACING_SUMMARY_INVALID"
    );
  }

  return text;
}

function normalizeRules(value: unknown) {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 50
  ) {
    throw new Error(
      "GUEST_AGREEMENT_RULES_INVALID"
    );
  }

  let serialized: string;

  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error(
      "GUEST_AGREEMENT_RULES_INVALID"
    );
  }

  if (
    !serialized ||
    serialized.length > 20000
  ) {
    throw new Error(
      "GUEST_AGREEMENT_RULES_INVALID"
    );
  }

  return JSON.parse(
    serialized
  ) as Prisma.InputJsonValue;
}

function normalizeOptionalRules(value: unknown) {
  if (
    value === undefined ||
    value === null
  ) {
    return null;
  }

  return normalizeRules(value);
}

function jsonEquals(
  first: unknown,
  second: unknown
) {
  return (
    JSON.stringify(first ?? null) ===
    JSON.stringify(second ?? null)
  );
}

dashboardGuestAccessSettingsRouter.get(
  "/api/dashboard/properties/:propertyId/guest-access-settings",
  requireAuth,
  async (req, res) => {
    try {
      const user = (req as any).user;
      const organizationId = String(
        user.orgId
      );

      const propertyId = String(
        req.params.propertyId ?? ""
      ).trim();

      const property =
        await prisma.property.findFirst({
          where: {
            id: propertyId,
            organizationId,
            status: "ACTIVE",
          },
          select: {
            id: true,
            name: true,
            maxGuests: true,
            guestAccessMode: true,
            cleaningNfcEnabled: true,
            guestAgreements: {
              where: {
                isActive: true,
              },
              orderBy: {
                updatedAt: "desc",
              },
              take: 1,
              select: {
                id: true,
                version: true,
                title: true,
                agreementText: true,
                rules: true,
                guestFacingSummary: true,
                titleEn: true,
                titleEs: true,
                agreementTextEn: true,
                agreementTextEs: true,
                rulesEn: true,
                rulesEs: true,
                guestFacingSummaryEn: true,
                guestFacingSummaryEs: true,
                requiresIdentityVerification:
                  true,
                requiresAgreementSignature:
                  true,
                isActive: true,
                createdAt: true,
                updatedAt: true,
              },
            },
          },
        });

      if (!property) {
        return res.status(404).json({
          ok: false,
          error: "PROPERTY_NOT_FOUND",
        });
      }

      const activeAgreement =
        property.guestAgreements[0] ?? null;

      return res.json({
        ok: true,
        settings: {
          propertyId: property.id,
          propertyName: property.name,
          maxGuests: property.maxGuests,
          guestAccessMode:
            property.guestAccessMode,
          cleaningNfcEnabled:
            property.cleaningNfcEnabled,
          configured:
            Boolean(activeAgreement) &&
            Number.isInteger(
              property.maxGuests
            ) &&
            Number(property.maxGuests) > 0,
          activeAgreement,
        },
      });
    } catch (error: any) {
      console.error(
        "[GUEST_ACCESS_SETTINGS_GET]",
        error?.message ?? error
      );

      return res.status(500).json({
        ok: false,
        error:
          "GUEST_ACCESS_SETTINGS_LOAD_FAILED",
      });
    }
  }
);

dashboardGuestAccessSettingsRouter.put(
  "/api/dashboard/properties/:propertyId/guest-access-settings",
  requireAuth,
  async (req, res) => {
    try {
      const user = (req as any).user;
      const organizationId = String(
        user.orgId
      );

      const propertyId = String(
        req.params.propertyId ?? ""
      ).trim();

      const requestedMode = String(
        req.body?.guestAccessMode ?? ""
      )
        .trim()
        .toUpperCase();

      const cleaningNfcEnabled =
        req.body?.cleaningNfcEnabled === true;

      if (
        req.body?.requiresIdentityVerification !== undefined &&
        typeof req.body.requiresIdentityVerification !== "boolean"
      ) {
        return res.status(400).json({
          ok: false,
          error: "IDENTITY_VERIFICATION_REQUIREMENT_INVALID",
        });
      }

      const requiresIdentityVerification =
        req.body?.requiresIdentityVerification !== false;

      if (
        requestedMode !==
          GuestAccessMode.PASSCODE_ONLY &&
        requestedMode !==
          GuestAccessMode.PASSCODE_PLUS_NFC
      ) {
        return res.status(400).json({
          ok: false,
          error:
            "GUEST_ACCESS_MODE_INVALID",
        });
      }

     const legacyTitle = cleanRequiredText(
  req.body?.titleEn ?? req.body?.title,
  "GUEST_AGREEMENT_TITLE_EN",
  3,
  160
);

const legacyAgreementText =
  cleanRequiredText(
    req.body?.agreementTextEn ??
      req.body?.agreementText,
    "GUEST_AGREEMENT_TEXT_EN",
    50,
    20000
  );

const legacyGuestFacingSummary =
  cleanOptionalText(
    req.body?.guestFacingSummaryEn ??
      req.body?.guestFacingSummary,
    1000
  );

const legacyRules = normalizeRules(
  req.body?.rulesEn ?? req.body?.rules
);

const titleEn = legacyTitle;

const agreementTextEn =
  legacyAgreementText;

const guestFacingSummaryEn =
  legacyGuestFacingSummary;

const rulesEn = legacyRules;

const titleEs =
  cleanOptionalRequiredText(
    req.body?.titleEs,
    "GUEST_AGREEMENT_TITLE_ES",
    3,
    160
  );

const agreementTextEs =
  cleanOptionalRequiredText(
    req.body?.agreementTextEs,
    "GUEST_AGREEMENT_TEXT_ES",
    50,
    20000
  );

const guestFacingSummaryEs =
  cleanOptionalText(
    req.body?.guestFacingSummaryEs,
    1000
  );

const rulesEs =
  normalizeOptionalRules(
    req.body?.rulesEs
  );
      const result =
        await prisma.$transaction(
          async (tx) => {
            const property =
              await tx.property.findFirst({
                where: {
                  id: propertyId,
                  organizationId,
                  status: "ACTIVE",
                },
                select: {
                  id: true,
                  name: true,
                  maxGuests: true,
                  guestAccessMode: true,
                  cleaningNfcEnabled: true,
                },
              });

            if (!property) {
              throw new Error(
                "PROPERTY_NOT_FOUND"
              );
            }

            if (
              !Number.isInteger(
                property.maxGuests
              ) ||
              Number(property.maxGuests) < 1
            ) {
              throw new Error(
                "PROPERTY_MAX_GUESTS_MISSING"
              );
            }

            const activeAgreement =
              await tx.propertyGuestAgreement.findFirst(
                {
                  where: {
                    propertyId,
                    isActive: true,
                  },
                  orderBy: {
                    updatedAt: "desc",
                  },
                }
              );

           const agreementUnchanged =
  Boolean(activeAgreement) &&
  activeAgreement?.title ===
    legacyTitle &&
  activeAgreement?.agreementText ===
    legacyAgreementText &&
  activeAgreement?.guestFacingSummary ===
    legacyGuestFacingSummary &&
  jsonEquals(
    activeAgreement?.rules,
    legacyRules
  ) &&
  activeAgreement?.titleEn ===
    titleEn &&
  activeAgreement?.titleEs ===
    titleEs &&
  activeAgreement?.agreementTextEn ===
    agreementTextEn &&
  activeAgreement?.agreementTextEs ===
    agreementTextEs &&
  activeAgreement?.guestFacingSummaryEn ===
    guestFacingSummaryEn &&
  activeAgreement?.guestFacingSummaryEs ===
    guestFacingSummaryEs &&
  jsonEquals(
    activeAgreement?.rulesEn,
    rulesEn
  ) &&
  jsonEquals(
    activeAgreement?.rulesEs,
    rulesEs
  ) &&
  activeAgreement
    ?.requiresIdentityVerification ===
    requiresIdentityVerification &&
  activeAgreement
    ?.requiresAgreementSignature ===
    true;
             
            const updatedProperty =
              await tx.property.update({
                where: {
                  id: property.id,
                },
                data: {
                  guestAccessMode:
                    requestedMode as GuestAccessMode,
                  cleaningNfcEnabled,
                },
                select: {
                  id: true,
                  name: true,
                  maxGuests: true,
                  guestAccessMode: true,
                  cleaningNfcEnabled: true,
                },
              });

            if (
              agreementUnchanged &&
              activeAgreement
            ) {
              return {
                property: updatedProperty,
                activeAgreement,
                newVersionCreated: false,
              };
            }

            await tx.propertyGuestAgreement.updateMany(
              {
                where: {
                  propertyId,
                  isActive: true,
                },
                data: {
                  isActive: false,
                },
              }
            );

            const version =
              `v-${new Date()
                .toISOString()
                .replace(
                  /[:.]/g,
                  "-"
                )}`;

            const createdAgreement =
              await tx.propertyGuestAgreement.create(
                {
                   data: {
                     propertyId,
                     version,

                     // Legacy compatibility fields.
                     title: legacyTitle,
                     agreementText:
                       legacyAgreementText,
                     rules: legacyRules,
                     guestFacingSummary:
                       legacyGuestFacingSummary,

                    // Localized agreement fields.
                    titleEn,
                    titleEs,
                    agreementTextEn,
                    agreementTextEs,
                    rulesEn,
                    rulesEs,
                    guestFacingSummaryEn,
                    guestFacingSummaryEs,
                    requiresIdentityVerification:
                      requiresIdentityVerification,
                    requiresAgreementSignature:
                      true,
                    isActive: true,
                  },
                }
              );

            return {
              property: updatedProperty,
              activeAgreement:
                createdAgreement,
              newVersionCreated: true,
            };
          }
        );

      console.log(
        "[GUEST_ACCESS_SETTINGS] saved",
        {
          propertyId:
            result.property.id,
          organizationId,
          guestAccessMode:
            result.property.guestAccessMode,
          cleaningNfcEnabled:
            result.property.cleaningNfcEnabled,
          requiresIdentityVerification:
            result.activeAgreement.requiresIdentityVerification,
          agreementVersion:
            result.activeAgreement.version,
          newVersionCreated:
            result.newVersionCreated,
        }
      );

      return res.json({
        ok: true,
        settings: {
          propertyId:
            result.property.id,
          propertyName:
            result.property.name,
          maxGuests:
            result.property.maxGuests,
          guestAccessMode:
            result.property.guestAccessMode,
          cleaningNfcEnabled:
            result.property.cleaningNfcEnabled,
          configured: true,
          activeAgreement:
            result.activeAgreement,
        },
        newVersionCreated:
          result.newVersionCreated,
      });
    } catch (error: any) {
      const code = String(
        error?.message ?? error
      );

      if (code === "PROPERTY_NOT_FOUND") {
        return res.status(404).json({
          ok: false,
          error: code,
        });
      }

      if (
        code ===
        "PROPERTY_MAX_GUESTS_MISSING"
      ) {
        return res.status(409).json({
          ok: false,
          error: code,
        });
      }

      if (
        code.endsWith("_INVALID")
      ) {
        return res.status(400).json({
          ok: false,
          error: code,
        });
      }

      console.error(
        "[GUEST_ACCESS_SETTINGS_PUT]",
        code
      );

      return res.status(500).json({
        ok: false,
        error:
          "GUEST_ACCESS_SETTINGS_SAVE_FAILED",
      });
    }
  }
);
