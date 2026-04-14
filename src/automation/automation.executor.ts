// automation.executor.ts

import { PrismaClient } from "@prisma/client";
import { getValidTuyaAccessToken } from "../integrations/tuya/tuya.auth.ts";
import { tuyaRequest } from "../integrations/tuya/tuya.http.ts";
import buildTuyaCommands from "../automation/tuya/tuya.command.mapper";

const prisma = new PrismaClient();

async function sendTuyaCommand(params: {
  externalId: string;
  deviceCategory?: string | null;
  deviceProfile?: string | null;
  functions?: any[] | null;
  action: string;
  value?: unknown;
}) {
  const accessToken = await getValidTuyaAccessToken();

  const result = buildTuyaCommands({
    deviceProfile: params.deviceProfile,
    deviceKind: params.deviceCategory,
    action: params.action,
    value: params.value,
    functions: Array.isArray(params.functions) ? params.functions : null,
  });

  // 🔴 IMPORTANTE: distinguir mapping inválido
  if (!result.ok) {
    return {
      ok: false,
      type: "MAPPING_FAILED",
      error: result.error || "TUYA_COMMAND_MAPPING_FAILED",
    };
  }

  try {
    await tuyaRequest({
      method: "POST",
      path: `/v1.0/iot-03/devices/${params.externalId}/commands`,
      accessToken,
      body: {
        commands: result.commands,
      },
    });

    return { ok: true };
  } catch (err: any) {
    return {
      ok: false,
      type: "EXECUTION_FAILED",
      error: String(err?.message ?? err),
    };
  }
}

async function createAutomationExecutionLog(params: {
  organizationId: string;
  propertyId: string;
  reservationId?: string | null;
  trigger: string;
  source: "RULE_ACTION" | "PROPERTY_AUTOMATION_DEVICE" | "GUEST_EXPERIENCE";
  deviceName?: string | null;
  deviceCategory?: string | null;
  externalId?: string | null;
  action?: string | null;
  value?: unknown;
  status: "SUCCESS" | "FAILED";
  errorMessage?: string | null;
  executedAt?: Date;
}) {
  try {
    await prisma.automationExecutionLog.create({
      data: {
        organizationId: params.organizationId,
        propertyId: params.propertyId,
        reservationId: params.reservationId ?? null,
        trigger: params.trigger,
        source: params.source,
        deviceName: params.deviceName ?? null,
        deviceCategory: params.deviceCategory ?? null,
        externalId: params.externalId ?? null,
        action: params.action ?? null,
        value: params.value === undefined ? null : (params.value as any),
        status: params.status,
        errorMessage: params.errorMessage ?? null,
        executedAt: params.executedAt ?? new Date(),
      },
    });
  } catch (err: any) {
    console.error("[automation] failed to persist execution log", err);
  }
}

export async function runAutomation(params: {
  organizationId: string;
  propertyId: string;
  trigger: string;
  reservationId?: string | null;
  now?: Date;
  reservationCheckIn?: Date | string | null; // 🔥 NUEVO

}) {
  const { organizationId, propertyId, reservationId } = params;
  const trigger = String(params.trigger ?? "").trim().toUpperCase();
  const now = params.now ?? new Date();
  const reservationCheckIn = params.reservationCheckIn
    ? new Date(params.reservationCheckIn)
    : null;

  const handledDevices = new Map<string, { source: string; action: string }>();

  let rulesExecuted = 0;
  let deviceFlagsExecuted = 0;
  let guestExperienceExecuted = 0;

  const executionErrors: any[] = [];

  // 🔥 helper clave
  async function tryExecuteDevice(params: {
    source: "GUEST_EXPERIENCE" | "PROPERTY_AUTOMATION_DEVICE" | "RULE_ACTION";
    externalId: string;
    deviceName?: string | null;
    deviceCategory?: string | null;
    deviceProfile?: string | null;
    functions?: any[] | null;
    action: string;
    value?: unknown;
  }) {
    const result = await sendTuyaCommand({
      externalId: params.externalId,
      deviceCategory: params.deviceCategory,
      deviceProfile: params.deviceProfile,
      functions: params.functions,
      action: params.action,
      value: params.value,
    });

    if (result.ok) {
      handledDevices.set(params.externalId, {
        source: params.source,
        action: params.action,
      });

      console.log("[automation] executed", params);

      await createAutomationExecutionLog({
        organizationId,
        propertyId,
        reservationId,
        trigger,
        source: params.source,
        deviceName: params.deviceName,
        deviceCategory: params.deviceCategory,
        externalId: params.externalId,
        action: params.action,
        value: params.value,
        status: "SUCCESS",
        executedAt: now,
      });

      return { success: true };
    }

    // 🔴 mapping error → NO bloquear fallback
    if (result.type === "MAPPING_FAILED") {
      console.log("[automation] mapping failed (fallback allowed)", params);
      return { success: false, fallback: true };
    }

    // 🔴 ejecución fallida → sí registrar error
    executionErrors.push({
      source: params.source,
      externalId: params.externalId,
      message: result.error,
    });

    await createAutomationExecutionLog({
      organizationId,
      propertyId,
      reservationId,
      trigger,
      source: params.source,
      deviceName: params.deviceName,
      deviceCategory: params.deviceCategory,
      externalId: params.externalId,
      action: params.action,
      value: params.value,
      status: "FAILED",
      errorMessage: result.error,
      executedAt: now,
    });

    return { success: false, fallback: false };
  }

  // =========================
  // 1. GUEST EXPERIENCE
  // =========================
  const settings = await prisma.propertyAutomationSettings.findUnique({
    where: { propertyId },
  });

  const guestDevices = Array.isArray(settings?.guestExperienceDevices)
    ? (settings!.guestExperienceDevices as any[])
    : [];

  const propertyDevices = await prisma.propertyAutomationDevice.findMany({
    where: {
      organizationId,
      propertyId,
      isEnabled: true,
    },
  });

  for (const config of guestDevices) {
    const externalId = String(config?.externalDeviceId ?? "").trim();
    if (!externalId) continue;
    if (handledDevices.has(externalId)) continue;

    const device = propertyDevices.find(
      (d) => String(d.externalDeviceId) === externalId
    );
    if (!device) continue;

    let action =
      trigger === "CHECK_IN"
        ? config?.checkInAction
        : config?.checkOutAction;

    if (!action || action === "NONE") continue;

    // 🔥 DETECTAR ALARMA
const categoryRaw = String(device.deviceCategory ?? "").toLowerCase();

const isAlarm =
  categoryRaw.includes("alarm") ||
  categoryRaw.includes("security") ||
  categoryRaw.includes("siren") ||
  categoryRaw.includes("mal");

// 🔥 FIX: alarma NO usa arrival offset
if (isAlarm && trigger === "CHECK_IN" && reservationCheckIn) {
  if (now.getTime() < reservationCheckIn.getTime()) {
    // todavía no es hora → NO ejecutar
    continue;
  }
}

     const result = await tryExecuteDevice({
      source: "GUEST_EXPERIENCE",
      externalId,
      deviceName: device.deviceName,
      deviceCategory: device.deviceCategory,
      deviceProfile: (device as any).deviceProfile,
      functions: (device as any).tuyaFunctions,
      action,
      value: config?.temperature ?? config?.brightness ?? null,
    });

    if (result.success) guestExperienceExecuted++;
  }

  // =========================
  // 2. PROPERTY DEVICES
  // =========================
  for (const device of propertyDevices) {
    const externalId = String(device.externalDeviceId ?? "").trim();
    if (!externalId) continue;
    if (handledDevices.has(externalId)) continue;

    const shouldRun =
      (trigger === "CHECK_IN" && device.autoOnAtCheckIn) ||
      (trigger === "CHECK_OUT" && device.autoOffAtCheckOut);

    if (!shouldRun) continue;

    const result = await tryExecuteDevice({
      source: "PROPERTY_AUTOMATION_DEVICE",
      externalId,
      deviceName: device.deviceName,
      deviceCategory: device.deviceCategory,
      deviceProfile: (device as any).deviceProfile,
      functions: (device as any).tuyaFunctions,
      action: trigger === "CHECK_IN" ? "TURN_ON" : "TURN_OFF",
    });

    if (result.success) deviceFlagsExecuted++;
  }

  // =========================
  // 3. RULES
  // =========================
  const rules = await prisma.automationRule.findMany({
    where: { organizationId, propertyId, trigger, isActive: true },
    include: { actions: { include: { device: true } } },
  });

  for (const rule of rules) {
    for (const ruleAction of rule.actions) {
      const device = ruleAction.device;
      if (!device?.externalId) continue;

      const externalId = String(device.externalId).trim();
      if (!externalId) continue;
      if (handledDevices.has(externalId)) continue;

      const result = await tryExecuteDevice({
        source: "RULE_ACTION",
        externalId,
        deviceName: (device as any).name,
        deviceCategory: (device as any).category,
        deviceProfile: null,
        functions: (device as any).metadata?.functions ?? null,
        action: ruleAction.action,
        value: ruleAction.value ?? null,
      });

      if (result.success) rulesExecuted++;
    }
  }

  return {
    ok: true,
    trigger,
    rulesExecuted,
    deviceFlagsExecuted,
    guestExperienceExecuted,
    errorCount: executionErrors.length,
    errors: executionErrors,
  };
}