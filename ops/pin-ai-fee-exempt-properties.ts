import { PrismaClient } from "@prisma/client";

// Audit first; apply requires this explicit deployment-only switch. No host
// activation, consent, reservation, payment or historical fee is modified.
const targets = [
  ["Casa Collores"], ["Pin&Go Demo Property", "PinGo demo property"],
  ["Serena Studio"], ["Remanso de Paz"],
];
const db = new PrismaClient();
try {
  await db.$transaction(async tx => {
    const matches = [];
    for (const names of targets) {
      const rows = await tx.property.findMany({ where: { OR: names.map(name => ({ name: { equals: name, mode: "insensitive" as const } })) },
        select: { id: true, organizationId: true, name: true, pinAIFeeExempt: true } });
      if (rows.length !== 1) throw new Error(`PROPERTY_IDENTIFICATION_AMBIGUOUS:${names[0]}:${rows.length}`);
      matches.push(rows[0]!);
    }
    console.log(JSON.stringify({ audit: "PIN_AI_PROPERTY_FEE_EXEMPTION", properties: matches }));
    if (process.env.PIN_AI_APPLY_PROPERTY_FEE_EXEMPTIONS !== "true") return;
    for (const p of matches) await tx.property.update({ where: { id: p.id, organizationId: p.organizationId },
      data: { pinAIFeeExempt: true } });
    console.log(JSON.stringify({ applied: true, count: matches.length }));
  }, { isolationLevel: "Serializable" });
} finally { await db.$disconnect(); }
