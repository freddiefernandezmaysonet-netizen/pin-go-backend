from pathlib import Path

worker = Path("src/workers/reservation.worker.ts")
text = worker.read_text(encoding="utf-8")

import_anchor = '''import {
  GUEST_ACCESS_ADMISSION_SAFETY_INTERVAL_MS,
  runGuestAccessAdmissionSafetyCycle,
} from "../e14/guest-access-admission-safety-cycle.e14";
'''
import_insert = import_anchor + '''import {
  resolveGuestAccessAmbiguityE15Config,
} from "../e15/guest-access-ambiguity-reconciliation.config.e15";
import {
  runGuestAccessAmbiguityReconciliationCycle,
} from "../e15/guest-access-ambiguity-reconciliation.e15";
'''
if text.count(import_anchor) != 1:
    raise SystemExit(f"E15 worker import anchor count={text.count(import_anchor)}")
text = text.replace(import_anchor, import_insert, 1)

config_anchor = '''const GUEST_ACCESS_ADMISSION_E14_CONFIG =
  resolveGuestAccessAdmissionE14Config(
    process.env
  );
'''
config_insert = config_anchor + '''const GUEST_ACCESS_AMBIGUITY_E15_CONFIG =
  resolveGuestAccessAmbiguityE15Config(
    process.env
  );
'''
if text.count(config_anchor) != 1:
    raise SystemExit(f"E15 worker config anchor count={text.count(config_anchor)}")
text = text.replace(config_anchor, config_insert, 1)

timer_anchor = "let lastGuestAccessAdmissionSafetyAt = 0;\n"
if text.count(timer_anchor) != 1:
    raise SystemExit(f"E15 worker timer anchor count={text.count(timer_anchor)}")
text = text.replace(
    timer_anchor,
    timer_anchor + "let lastGuestAccessAmbiguityE15At = 0;\n",
    1,
)

financial_anchor = '''      if (
        GUEST_JOURNEY_FINANCIAL_OWNER_CONFIG.enabled
      ) {
'''
e15_block = '''      if (
        GUEST_ACCESS_AMBIGUITY_E15_CONFIG.enabled &&
        now.getTime() - lastGuestAccessAmbiguityE15At >=
          GUEST_ACCESS_AMBIGUITY_E15_CONFIG.intervalMs
      ) {
        lastGuestAccessAmbiguityE15At = now.getTime();
        try {
          const e15Metrics =
            await runGuestAccessAmbiguityReconciliationCycle(
              prisma,
              {
                config: GUEST_ACCESS_AMBIGUITY_E15_CONFIG,
                scope: {
                  organizationIds:
                    GUEST_JOURNEY_ACCESS_OWNER_CONFIG.organizationIds,
                  propertyIds:
                    GUEST_JOURNEY_ACCESS_OWNER_CONFIG.propertyIds,
                },
                e14Enabled:
                  GUEST_ACCESS_ADMISSION_E14_CONFIG.enabled,
                accessOwnerEnabled:
                  GUEST_JOURNEY_ACCESS_OWNER_CONFIG.enabled,
                now,
              }
            );

          log(
            "guest-access-ambiguity-reconciliation-e15",
            e15Metrics
          );
        } catch (e) {
          errLog(
            "guest-access-ambiguity-reconciliation-e15 crashed:",
            toErrString(e)
          );
        }
      }

'''
if text.count(financial_anchor) != 1:
    raise SystemExit(f"E15 worker financial anchor count={text.count(financial_anchor)}")
text = text.replace(financial_anchor, e15_block + financial_anchor, 1)

worker.write_text(text, encoding="utf-8")
