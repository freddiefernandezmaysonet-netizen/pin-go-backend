import { Router } from "express";
import type { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";

type AuthedRequest = Request & {
  user?: {
    orgId?: string;
    id?: string;
    email?: string;
    role?: string;
  };
};

type GuestExperienceDeviceInput = {
  externalDeviceId: string;
  deviceName: string;
  deviceCategory: string | null;
  enabled: boolean;
  checkInAction: "NONE" | "TURN_ON" | "SET_COMFORT" | "DISARM";
  checkOutAction: "NONE" | "TURN_OFF" | "ARM";
  temperature?: number | null;
  brightness?: number | null;
  mode?: "cool" | "heat" | "auto" | null;
};

function asObject(value: unknown): Record<string, any> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, any>)
    : {};
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNullableString(value: unknown): string | null {
  const text = normalizeString(value);
  return text ? text : null;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeCheckInAction(value: unknown): GuestExperienceDeviceInput["checkInAction"] {
  const action = normalizeString(value).toUpperCase();

  if (action === "TURN_ON" || action === "SET_COMFORT" || action === "DISARM") {
    return action;
  }

  return "NONE";
}

function normalizeCheckOutAction(value: unknown): GuestExperienceDeviceInput["checkOutAction"] {
  const action = normalizeString(value).toUpperCase();

  if (action === "TURN_OFF" || action === "ARM") {
    return action;
  }

  return "NONE";
}

function normalizeMode(value: unknown): GuestExperienceDeviceInput["mode"] {
  const mode = normalizeString(value).toLowerCase();
  if (mode === "cool" || mode === "heat" || mode === "auto") return mode;
  return null;
}

function normalizeGuestExperienceDevice(d: any): GuestExperienceDeviceInput | null {
  const externalDeviceId = normalizeString(d?.externalDeviceId);
  if (!externalDeviceId) return null;

  const categoryRaw = normalizeString(d?.deviceCategory).toLowerCase();

  const isAlarm =
    categoryRaw.includes("alarm") ||
    categoryRaw.includes("security") ||
    categoryRaw.includes("siren") ||
    categoryRaw.includes("mal");

  const isAC =
    categoryRaw.includes("ac") ||
    categoryRaw.includes("air") ||
    categoryRaw.includes("climate") ||
    categoryRaw.includes("hvac");

  const isLight =
    categoryRaw.includes("light") ||
    categoryRaw.includes("lamp") ||
    categoryRaw.includes("dj") ||
    categoryRaw.includes("led");

  let checkInAction = normalizeCheckInAction(d?.checkInAction);
  let checkOutAction = normalizeCheckOutAction(d?.checkOutAction);

  // 🔥 FIX CRÍTICO: VALIDACIÓN POR TIPO
  if (isAlarm) {
    checkInAction = checkInAction === "DISARM" ? "DISARM" : "DISARM";
    checkOutAction = checkOutAction === "ARM" ? "ARM" : "ARM";
  }

  if (isAC) {
    if (checkInAction !== "SET_COMFORT") {
      checkInAction = "SET_COMFORT";
    }
  }

  if (isLight) {
    if (checkInAction !== "TURN_ON") {
      checkInAction = "TURN_ON";
    }
  }

  const temperature =
    typeof d?.temperature === "number" && Number.isFinite(d.temperature)
      ? d.temperature
      : null;

  const brightness =
    typeof d?.brightness === "number" && Number.isFinite(d.brightness)
      ? d.brightness
      : null;

  // 🔥 VALIDACIÓN EXISTENTE
  if (checkInAction === "SET_COMFORT" && temperature == null) {
    return null;
  }

  return {
    externalDeviceId,
    deviceName: normalizeString(d?.deviceName) || "Unnamed device",
    deviceCategory: normalizeNullableString(d?.deviceCategory),
    enabled: normalizeBoolean(d?.enabled, true),
    checkInAction,
    checkOutAction,
    temperature,
    brightness,
    mode: normalizeMode(d?.mode),
  };
}

export function buildPropertyAutomationRouter(prisma: PrismaClient) {
  const router = Router();

  // =========================
  // GET
  // =========================
  router.get("/:id/automation-settings", async (req: AuthedRequest, res: Response) => {
    try {
      const propertyId = String(req.params.id ?? "").trim();
      const orgId = String(req.user?.orgId ?? "").trim();

      if (!orgId) {
        return res.status(401).json({ ok: false, error: "UNAUTHENTICATED" });
      }

      const property = await prisma.property.findFirst({
        where: { id: propertyId, organizationId: orgId },
      });

      if (!property) {
        return res.status(404).json({ ok: false, error: "PROPERTY_NOT_FOUND" });
      }

      const settings = await prisma.propertyAutomationSettings.findUnique({
        where: { propertyId },
      });

      const devices = await prisma.propertyAutomationDevice.findMany({
        where: { propertyId },
      });

      return res.json({
        ok: true,
        property,
        settings,
        devices,
      });
    } catch (err) {
      console.error(err);
      return res.status(500).json({ ok: false });
    }
  });

  // =========================
  // POST
  // =========================
  router.post("/:id/automation-settings", async (req: AuthedRequest, res: Response) => {
    try {
      const propertyId = String(req.params.id ?? "").trim();
      const orgId = String(req.user?.orgId ?? "").trim();

      if (!orgId) {
        return res.status(401).json({ ok: false, error: "UNAUTHENTICATED" });
      }

      const property = await prisma.property.findFirst({
        where: { id: propertyId, organizationId: orgId },
      });

      if (!property) {
        return res.status(404).json({ ok: false, error: "PROPERTY_NOT_FOUND" });
      }

      const willEnableSmart =
        typeof req.body?.automationEnabled === "boolean"
          ? req.body.automationEnabled
          : true;

      const arrivalOffsetMinutes = Number(req.body?.arrivalOffsetMinutes);
      const departureOffsetMinutes = Number(req.body?.departureOffsetMinutes);

      const normalizedArrivalOffsetMinutes =
        Number.isFinite(arrivalOffsetMinutes) && arrivalOffsetMinutes >= 0
          ? Math.trunc(arrivalOffsetMinutes)
          : 30;

      const normalizedDepartureOffsetMinutes =
        Number.isFinite(departureOffsetMinutes) && departureOffsetMinutes >= 0
          ? Math.trunc(departureOffsetMinutes)
          : 15;

      const rawDevices = Array.isArray(req.body?.devices) ? req.body.devices : [];

      const normalizedDevices = rawDevices
        .map((d: any) => {
          const externalDeviceId = normalizeString(d?.externalDeviceId);
          if (!externalDeviceId) return null;

          return {
            provider: normalizeString(d?.provider) || "TUYA",
            externalDeviceId,
            deviceName: normalizeString(d?.deviceName) || "Unnamed device",
            deviceCategory: normalizeNullableString(d?.deviceCategory),
            isEnabled: normalizeBoolean(d?.isEnabled, true),
            autoOnAtCheckIn: normalizeBoolean(d?.autoOnAtCheckIn, true),
            autoOffAtCheckOut: normalizeBoolean(d?.autoOffAtCheckOut, true),
          };
        })
        .filter(Boolean);

      const rawGuestExperience = asObject(req.body?.guestExperience);

      const guestExperienceEnabled = normalizeBoolean(rawGuestExperience.enabled, true);

      const normalizedGuestExperienceDevices = (Array.isArray(rawGuestExperience.devices)
        ? rawGuestExperience.devices
        : []
      )
        .map(normalizeGuestExperienceDevice)
        .filter(Boolean);

     // 🔒 ENTITLEMENT GUARD (CRÍTICO)
if (willEnableSmart) {
  const subscription = await prisma.subscription.findFirst({
    where: {
      organizationId: orgId,
    },
    orderBy: {
      createdAt: "desc",
    },
    select: {
      entitledSmartProperties: true,
      status: true,
    },
  });

  const isActive =
    subscription &&
    (subscription.status === "ACTIVE" ||
      subscription.status === "TRIALING");

  const smartLimit = isActive
    ? subscription?.entitledSmartProperties ?? 0
    : 0;

  if (smartLimit < 1) {
    return res.status(403).json({
      ok: false,
      error: "SMART_PROPERTY_ENTITLEMENT_REQUIRED",
      smartLimit,
    });
  }

  const smartUsed = await prisma.property.count({
    where: {
      organizationId: orgId,
      smartAutomationEnabled: true,
      NOT: { id: propertyId },
    },
  });

  if (smartUsed >= smartLimit) {
    return res.status(403).json({
      ok: false,
      error: "SMART_CAPACITY_EXCEEDED",
      smartUsed,
      smartLimit,
    });
  }
}

       await prisma.$transaction(async (tx) => {
        await tx.property.update({
          where: { id: propertyId },
          data: { smartAutomationEnabled: willEnableSmart },
        });

        await tx.propertyAutomationSettings.upsert({
          where: { propertyId },
          update: {
            automationEnabled: willEnableSmart,
            arrivalOffsetMinutes: normalizedArrivalOffsetMinutes,
            departureOffsetMinutes: normalizedDepartureOffsetMinutes,
            guestExperienceEnabled,
            guestExperienceDevices: normalizedGuestExperienceDevices as any,
          },
          create: {
            organizationId: orgId,
            propertyId,
            automationEnabled: willEnableSmart,
            arrivalOffsetMinutes: normalizedArrivalOffsetMinutes,
            departureOffsetMinutes: normalizedDepartureOffsetMinutes,
            guestExperienceEnabled,
            guestExperienceDevices: normalizedGuestExperienceDevices as any,
          },
        });

        await tx.propertyAutomationDevice.deleteMany({
          where: { propertyId },
        });

        for (const d of normalizedDevices as any[]) {
          await tx.propertyAutomationDevice.create({
            data: {
              organizationId: orgId,
              propertyId,
              provider: d.provider,
              externalDeviceId: d.externalDeviceId,
              deviceName: d.deviceName,
              deviceCategory: d.deviceCategory,
              isEnabled: d.isEnabled,
              autoOnAtCheckIn: d.autoOnAtCheckIn,
              autoOffAtCheckOut: d.autoOffAtCheckOut,
            },
          });
        }
      });

      return res.json({ ok: true });
    } catch (err: any) {
      console.error("automation save error", err);

      return res.status(500).json({
        ok: false,
        error: "FAILED_TO_SAVE_AUTOMATION_SETTINGS",
      });
    }
  });

  return router;
}