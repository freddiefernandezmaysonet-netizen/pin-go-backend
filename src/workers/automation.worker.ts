import { PrismaClient } from "@prisma/client";
import { runAutomation } from "../automation/automation.executor.ts";

const prisma = new PrismaClient();

let shuttingDown = false;
let tickInProgress = false;

function log(...args: any[]) {
  console.log("[automation.worker]", ...args);
}

function errLog(...args: any[]) {
  console.error("[automation.worker]", ...args);
}

const INTERVAL_MS = 60_000;
const WINDOW_MS = 2 * 60_000;

function isDue(now: Date, target: Date, windowMs: number) {
  return Math.abs(now.getTime() - target.getTime()) <= windowMs;
}

async function hasExecuted(
  reservationId: string,
  trigger: "CHECK_IN" | "CHECK_OUT"
) {
  const existing = await prisma.automationExecution.findFirst({
    where: {
      reservationId,
      trigger,
    },
    select: { id: true },
  });

  return !!existing;
}

// 🔥 FINAL: alineado con schema correcto
async function markExecuted(
  organizationId: string,
  propertyId: string,
  reservationId: string,
  trigger: "CHECK_IN" | "CHECK_OUT",
  executedAt: Date
) {
  try {
    await prisma.automationExecution.create({
      data: {
        organizationId,
        propertyId,
        reservationId,
        trigger,
        executedAt,
      },
    });
  } catch (err: any) {
    // 🔥 protección final contra duplicados
    if (err?.code === "P2002") {
      log("duplicate execution prevented", {
        reservationId,
        trigger,
      });
      return;
    }
    throw err;
  }
}

async function tick() {
  if (shuttingDown) return;

  // 🔥 evita solapamiento
  if (tickInProgress) {
    log("skip tick (previous still running)");
    return;
  }

  tickInProgress = true;

  const now = new Date();
  log("tick", now.toISOString());

  try {
    const reservations = await prisma.reservation.findMany({
      where: {
        status: {
          not: "CANCELLED" as any,
        },
        checkIn: {
          lte: new Date(now.getTime() + 24 * 60 * 60 * 1000),
        },
        checkOut: {
          gte: new Date(now.getTime() - 24 * 60 * 60 * 1000),
        },
      },
      select: {
        id: true,
        propertyId: true,
        checkIn: true,
        checkOut: true,
      },
      take: 200,
      orderBy: {
        checkIn: "asc",
      },
    });

    log("reservations found", reservations.length);

    for (const r of reservations) {
      try {
        const [property, settings] = await Promise.all([
          prisma.property.findUnique({
            where: { id: r.propertyId },
            select: { organizationId: true, name: true },
          }),
          prisma.propertyAutomationSettings.findUnique({
            where: { propertyId: r.propertyId },
            select: {
              automationEnabled: true,
              arrivalOffsetMinutes: true,
              departureOffsetMinutes: true,
            },
          }),
        ]);

        if (!property?.organizationId) {
          errLog("missing organizationId", {
            reservationId: r.id,
            propertyId: r.propertyId,
          });
          continue;
        }

        const automationEnabled = settings?.automationEnabled ?? true;
        const arrivalOffsetMinutes = settings?.arrivalOffsetMinutes ?? 30;
        const departureOffsetMinutes = settings?.departureOffsetMinutes ?? 15;

        if (!automationEnabled) {
          log("automation disabled", { reservationId: r.id });
          continue;
        }

        const checkInDueAt = new Date(
          new Date(r.checkIn).getTime() - arrivalOffsetMinutes * 60 * 1000
        );

        const checkOutDueAt = new Date(
          new Date(r.checkOut).getTime() + departureOffsetMinutes * 60 * 1000
        );

        const shouldRunCheckIn = isDue(now, checkInDueAt, WINDOW_MS);
        const shouldRunCheckOut = isDue(now, checkOutDueAt, WINDOW_MS);

        log("window", {
          reservationId: r.id,
          shouldRunCheckIn,
          shouldRunCheckOut,
        });

        // =========================
        // CHECK-IN
        // =========================
        if (shouldRunCheckIn) {
          const alreadyRan = await hasExecuted(r.id, "CHECK_IN");

          if (!alreadyRan) {
            log("executing CHECK_IN", { reservationId: r.id });

           const result = await runAutomation({
  organizationId: property.organizationId,
  propertyId: r.propertyId,
  trigger: "CHECK_IN",
  reservationId: r.id,
  now,
  reservationCheckIn: r.checkIn, // 🔥 NUEVO
});
         
            await markExecuted(
              property.organizationId,
              r.propertyId,
              r.id,
              "CHECK_IN",
              now
            );

            log("CHECK_IN done", result);
          } else {
            log("skip CHECK_IN already executed", {
              reservationId: r.id,
            });
          }
        }

        // =========================
        // CHECK-OUT
        // =========================
        if (shouldRunCheckOut) {
          const alreadyRan = await hasExecuted(r.id, "CHECK_OUT");

          if (!alreadyRan) {
            log("executing CHECK_OUT", { reservationId: r.id });

            const result = await runAutomation({
              organizationId: property.organizationId,
              propertyId: r.propertyId,
              trigger: "CHECK_OUT",
              reservationId: r.id,
              now,
            });

            await markExecuted(
              property.organizationId,
              r.propertyId,
              r.id,
              "CHECK_OUT",
              now
            );

            log("CHECK_OUT done", result);
          } else {
            log("skip CHECK_OUT already executed", {
              reservationId: r.id,
            });
          }
        }
      } catch (e: any) {
        errLog("runAutomation failed", {
          reservationId: r.id,
          propertyId: r.propertyId,
          err: String(e?.message ?? e),
        });
      }
    }
  } catch (e: any) {
    errLog("tick failed", String(e?.message ?? e));
  } finally {
    tickInProgress = false;
  }
}

export async function startAutomationWorker() {
  log("starting...");

  await tick();

  const interval = setInterval(() => {
    void tick();
  }, INTERVAL_MS);

  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;

    clearInterval(interval);
    log(`stopping (${signal})...`);

    try {
      await prisma.$disconnect();
    } catch (err) {
      errLog("disconnect failed", err);
    }

    log(`stopped (${signal})`);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void startAutomationWorker();