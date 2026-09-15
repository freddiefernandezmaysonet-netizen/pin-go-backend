import { readFileSync, writeFileSync } from "node:fs";

function replaceOnce(text, oldValue, newValue, label) {
  if (!text.includes(oldValue)) {
    throw new Error(`${label} anchor not found`);
  }
  return text.replace(oldValue, newValue);
}

const financialPath = "src/routes/financial.routes.ts";
let financial = readFileSync(financialPath, "utf8");

financial = replaceOnce(
  financial,
  `import { requireOrg } from "../middleware/requireOrg";\n`,
  `import { requireOrg } from "../middleware/requireOrg";\nimport { summarizeSmsFinancialTelemetry } from "../services/sms-financial-telemetry.service";\n`,
  "financial import"
);

financial = replaceOnce(
  financial,
  `const AVG_SMS_COST = 0.008;\n`,
  ``,
  "financial legacy SMS rate"
);

financial = replaceOnce(
  financial,
  `    const reservations = await prisma.reservation.count({\n      where: { organizationId: orgId },\n    });\n`,
  `    const reservations = await prisma.reservation.count({\n      where: { organizationId: orgId },\n    });\n\n    const smsSince = new Date();\n    smsSince.setDate(smsSince.getDate() - 30);\n\n    const twilioSmsMessages = await prisma.messageLog.findMany({\n      where: {\n        organizationId: orgId,\n        channel: "sms",\n        provider: "twilio",\n        status: "SENT",\n        createdAt: { gte: smsSince },\n      },\n      select: { body: true },\n    });\n\n    const smsTelemetry = summarizeSmsFinancialTelemetry(\n      twilioSmsMessages\n    );\n`,
  "financial SMS telemetry query"
);

financial = replaceOnce(
  financial,
  `    const estimatedSms = reservations * 4; // avg 4 SMS por reserva\n    const twilioCost = estimatedSms * AVG_SMS_COST;\n`,
  `    const twilioCost = smsTelemetry.estimatedCostUsd;\n`,
  "financial legacy SMS estimate"
);

financial = replaceOnce(
  financial,
  `      costs: {\n        stripe: stripeFee,\n        twilio: twilioCost,\n        tuya: tuyaCost,\n        total: totalCosts,\n      },\n`,
  `      smsTelemetry: {\n        period: "LAST_30_DAYS",\n        totalMessages: smsTelemetry.totalMessages,\n        totalSegments: smsTelemetry.totalSegments,\n        gsm7Messages: smsTelemetry.gsm7Messages,\n        ucs2Messages: smsTelemetry.ucs2Messages,\n        segmentRateUsd: smsTelemetry.segmentRateUsd,\n        estimateBasis: "SENT_TWILIO_MESSAGE_LOG_BODY_SEGMENTS_BASE_RATE",\n      },\n      costs: {\n        stripe: stripeFee,\n        twilio: twilioCost,\n        tuya: tuyaCost,\n        total: totalCosts,\n      },\n`,
  "financial response telemetry"
);

writeFileSync(financialPath, financial);

const adminPath = "src/routes/admin.financial.routes.ts";
let admin = readFileSync(adminPath, "utf8");

admin = replaceOnce(
  admin,
  `import { requireAuth } from "../middleware/requireAuth";\n`,
  `import { requireAuth } from "../middleware/requireAuth";\nimport { summarizeSmsFinancialTelemetry } from "../services/sms-financial-telemetry.service";\n`,
  "admin import"
);

admin = replaceOnce(
  admin,
  `const AVG_SMS_COST = 0.008;\n`,
  ``,
  "admin legacy SMS rate"
);

admin = replaceOnce(
  admin,
  `      totalSmsMessages,\n`,
  `      twilioSmsMessages,\n`,
  "admin global SMS variable"
);

admin = replaceOnce(
  admin,
  `      prisma.messageLog.count({\n        where: {\n          channel: "sms",\n          createdAt: {\n            gte: since,\n          },\n        },\n      }),\n`,
  `      prisma.messageLog.findMany({\n        where: {\n          channel: "sms",\n          provider: "twilio",\n          status: "SENT",\n          createdAt: {\n            gte: since,\n          },\n        },\n        select: {\n          body: true,\n          organizationId: true,\n        },\n      }),\n`,
  "admin global SMS query"
);

admin = replaceOnce(
  admin,
  `    ]);\n\n    const orgUsage = await Promise.all(\n`,
  `    ]);\n\n    const smsTelemetry = summarizeSmsFinancialTelemetry(\n      twilioSmsMessages\n    );\n\n    const smsMessagesByOrg = new Map<\n      string,\n      Array<{ body: string | null }>\n    >();\n\n    for (const message of twilioSmsMessages) {\n      if (!message.organizationId) continue;\n      const rows = smsMessagesByOrg.get(\n        message.organizationId\n      ) ?? [];\n      rows.push({ body: message.body });\n      smsMessagesByOrg.set(\n        message.organizationId,\n        rows\n      );\n    }\n\n    const orgUsage = await Promise.all(\n`,
  "admin SMS telemetry grouping"
);

admin = replaceOnce(
  admin,
  `          smsUsed,\n`,
  ``,
  "admin per-org SMS destructure"
);

admin = replaceOnce(
  admin,
  `          prisma.messageLog.count({\n            where: {\n              organizationId: org.id,\n              channel: "sms",\n              createdAt: {\n                gte: since,\n              },\n            },\n          }),\n\n`,
  ``,
  "admin per-org SMS count query"
);

admin = replaceOnce(
  admin,
  `        ]);\n\n        const subscription = subscriptions.find(\n`,
  `        ]);\n\n        const orgSmsTelemetry = summarizeSmsFinancialTelemetry(\n          smsMessagesByOrg.get(org.id) ?? []\n        );\n\n        const subscription = subscriptions.find(\n`,
  "admin per-org SMS telemetry"
);

admin = replaceOnce(
  admin,
  `            smsUsed, // últimos 30 días\n`,
  `            smsUsed: orgSmsTelemetry.totalMessages, // últimos 30 días\n            smsSegments: orgSmsTelemetry.totalSegments,\n`,
  "admin per-org SMS usage"
);

admin = replaceOnce(
  admin,
  `    // 🔥 COSTOS REALES (30 días)\n    const twilioCost = totalSmsMessages * AVG_SMS_COST;\n`,
  `    // Costo base estimado por segmentos de SMS enviados (30 días).\n    // No incluye carrier fees ni ajustes posteriores de factura Twilio.\n    const twilioCost = smsTelemetry.estimatedCostUsd;\n`,
  "admin legacy SMS cost"
);

admin = replaceOnce(
  admin,
  `        totalSmsMessages, // 30 días\n`,
  `        totalSmsMessages: smsTelemetry.totalMessages, // 30 días\n        totalSmsSegments: smsTelemetry.totalSegments,\n        twilioSmsSegmentRateUsd: smsTelemetry.segmentRateUsd,\n        smsCostEstimateBasis:\n          "SENT_TWILIO_MESSAGE_LOG_BODY_SEGMENTS_BASE_RATE",\n`,
  "admin SMS summary"
);

writeFileSync(adminPath, admin);
