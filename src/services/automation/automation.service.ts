import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export type AutomationTrigger =
  | "CHECK_IN"
  | "CHECK_OUT"
  | "CLEANING_START"
  | "CLEANING_END";

export async function runPropertyAutomations(params: {
  organizationId: string;
  propertyId: string;
  trigger: AutomationTrigger;
}) {
  const { organizationId, propertyId, trigger } = params;

  console.log("[automation] trigger", {
    organizationId,
    propertyId,
    trigger,
  });

  const rules = await prisma.automationRule.findMany({
    where: {
      organizationId,
      propertyId,
      trigger,
      isActive: true,
    },
    include: {
      actions: {
        include: {
          device: true,
        },
      },
    },
    orderBy: {
      createdAt: "asc",
    },
  });

  console.log("[automation] rules found", rules.length);

  for (const rule of rules) {
    console.log("[automation] executing rule", {
      ruleId: rule.id,
      trigger: rule.trigger,
      offsetMinutes: rule.offsetMinutes,
    });

    for (const action of rule.actions) {
      if (!action.device?.isActive) {
        console.log("[automation] skipped inactive device", {
          deviceId: action.deviceId,
        });
        continue;
      }

      console.log("[automation] ACTION", {
        deviceId: action.device.id,
        deviceName: action.device.name,
        deviceType: action.device.type,
        provider: action.device.provider,
        action: action.action,
        value: action.value,
      });

      // Provider adapters vendrán después.
      // Por ahora solo logging seguro.
      switch (action.device.provider) {
        case "MANUAL":
        case "OTHER":
        case "TUYA":
        case "MYQ":
        default:
          console.log("[automation] provider adapter pending", {
            provider: action.device.provider,
            externalId: action.device.externalId,
          });
          break;
      }
    }
  }

  console.log("[automation] done");
}