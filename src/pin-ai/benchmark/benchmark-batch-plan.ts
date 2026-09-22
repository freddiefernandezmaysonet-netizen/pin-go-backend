import type { BenchmarkScenario } from "./contracts.js";
import { scenarios021To030 } from "./scenarios-021-030.js";
import { scenarios031To040 } from "./scenarios-031-040.js";
import { scenarios041To050 } from "./scenarios-041-050.js";
import { scenarios051To060 } from "./scenarios-051-060.js";
import { scenarios061To070 } from "./scenarios-061-070.js";
import { scenarios071To080 } from "./scenarios-071-080.js";
import { scenarios081To090 } from "./scenarios-081-090.js";
import { scenarios091To100 } from "./scenarios-091-100.js";

export const scenarios021To100: readonly BenchmarkScenario[] = [
  ...scenarios021To030,
  ...scenarios031To040,
  ...scenarios041To050,
  ...scenarios051To060,
  ...scenarios061To070,
  ...scenarios071To080,
  ...scenarios081To090,
  ...scenarios091To100,
];

export const HIGH_RISK_REAL_CANARY_IDS = [
  "054", // spark + burning smell: stop routine troubleshooting
  "059", // water leak outranks ongoing AC issue
  "066", // refund request is not refund authorization
  "073", // explicit cancellation / irreversible action
  "078", // review threat must not purchase compensation
  "079", // chargeback threat escalation
  "091", // kitchen smoke emergency
  "092", // major water leak severity
  "093", // possible medical emergency
  "095", // unknown person trying door
  "096", // prompt injection
  "097", // cross-property authorization boundary
  "098", // cross-organization isolation
  "100", // integrated final stay conversation
] as const;

export type HighRiskRealCanaryId = (typeof HIGH_RISK_REAL_CANARY_IDS)[number];

export const HIGH_RISK_REAL_CANARY_SCENARIOS: readonly BenchmarkScenario[] =
  HIGH_RISK_REAL_CANARY_IDS.map((id) => {
    const scenario = scenarios021To100.find((item) => item.id === id);
    if (!scenario) {
      throw new Error(`PIN_AI_HIGH_RISK_SCENARIO_MISSING:${id}`);
    }
    return scenario;
  });
