from pathlib import Path
import subprocess


def load(path, expected_blob):
    actual = subprocess.check_output(['git', 'hash-object', path], text=True).strip()
    if actual != expected_blob:
        raise SystemExit(f'AUDITED_SOURCE_CHANGED:{path}:{actual}')
    return Path(path).read_bytes().decode('utf-8')


def once(text, old, new):
    if text.count(old) != 1:
        raise SystemExit(f'ANCHOR_COUNT_NOT_ONE:{old[:90]!r}')
    return text.replace(old, new, 1)


def cut(text, start, end):
    if text.count(start) != 1:
        raise SystemExit(f'START_COUNT_NOT_ONE:{start!r}')
    left = text.index(start)
    right = text.index(end, left + len(start))
    return text[:left] + text[right:]


path = 'src/routes/dashboard.properties.route.ts'
text = load(path, '2417deaa3dd6fab1f7b5aab26e64ed3b7c2a0e23')
text = once(text, '''import {
  deriveMissionControlNativeHealth,
} from "../apms/mission-control-runtime-health.e13";
import {
  GUEST_JOURNEY_RUNTIME_NAME,
  GUEST_JOURNEY_RUNTIME_SERVICE_NAME,
} from "../services/guest-journey-runtime-state.service";''', '''import {
  toObservationalMissionControlSnapshot,
} from "../apms/mission-control-observational";''')
text = cut(text, 'const runtimeEnvironment = String(\n', 'const [\n  activeOperationalIssueRows,')
text = once(text, '  allVisibilityCurrentIssueRows,\n  guestJourneyRuntimeRows,\n', '')
text = cut(text, '  prisma.operationalIssue.findMany({\n    where: {\n      workflowState: {', ']);\n\nconst operationalIssueRows')
text = once(text, '''const operationalReservationIds =
  [
    ...operationalIssueRows,
    ...allVisibilityCurrentIssueRows,
  ]''', '''const operationalReservationIds =
  operationalIssueRows''')
text = once(text, '''const allVisibilityCurrentItems =
  mapOperationalIssueRows(
    allVisibilityCurrentIssueRows
  );

''', '')
text = cut(text, '      const nativeHealth =\n', '      const hostInterventionRequired =\n')
text = once(text, '''        ...baseSnapshot,
        // E13 native current health. Runtime state and every OperationalIssue
        // visibility participate in health; only HOST items are exposed.
        autopilotStatus:
          nativeHealth.autopilotStatus,
        engineHealth:
          nativeHealth.engineHealth,''', '''        // Preserve operational reporting without claiming global engine health.
        ...toObservationalMissionControlSnapshot(baseSnapshot),''')
for forbidden in ['apmsRuntimeState', 'deriveMissionControlNativeHealth', 'allVisibilityCurrent', 'guestJourneyRuntimeRows']:
    if forbidden in text:
        raise SystemExit(f'RETIRED_DEPENDENCY_REMAINS:{forbidden}')
Path(path).write_bytes(text.encode('utf-8'))
print('Patched', path)

path = 'src/services/guest-journey-e13-runtime-truth.contract.test.ts'
text = load(path, '291c06aa3ed720f4a8e611342c712932355c5601')
start = 'test("E13 Mission Control consumes all visibility for health and returns HOST items only", () => {'
end = 'test("E13 removes the transitional E12 middleware from source and server wiring", () => {'
left, right = text.index(start), text.index(end)
new = r'''test("Mission Control host reporting preserves operations without Enterprise global health", () => {
  assert.doesNotMatch(propertyRoute, /deriveMissionControlNativeHealth|apmsRuntimeState|allVisibilityCurrentIssueRows/);
  assert.match(propertyRoute, /\.\.\.toObservationalMissionControlSnapshot\(baseSnapshot\)/);
  assert.match(propertyRoute, /organizationId: orgId,\s*propertyId: property\.id,\s*visibility: "HOST"/);
  assert.match(propertyRoute, /operationalItems,\s*\n\s*currentOperationalState/);
  assert.match(propertyRoute, /hostActionQueue,\s*\n\s*waitingItems,\s*\n\s*autoResolvingItems/);
  assert.match(propertyRoute, /guestJourneyMetrics,/);
  assert.match(propertyRoute, /activityHistory,\s*\n\s*recentAuditEntries: activityHistory/);
});

'''
text = text[:left] + new + text[right:]
Path(path).write_bytes(text.encode('utf-8'))
print('Updated host-reporting contract only', path)

path = 'src/services/guest-journey-runtime-enforcement.contract.test.ts'
text = load(path, 'c545a42fec5ade4767e2e8ee0e3fdf7f8301e33a')
start = 'test("Mission Control now derives current health natively from runtime truth and OperationalIssue", () => {'
left = text.index(start)
new = r'''test("Mission Control host reporting no longer depends on the Enterprise runtime gate", () => {
  assert.doesNotMatch(propertyRouteSource, /deriveMissionControlNativeHealth|prisma\.apmsRuntimeState|nativeHealth/);
  assert.match(propertyRouteSource, /toObservationalMissionControlSnapshot\(baseSnapshot\)/);
  assert.match(propertyRouteSource, /visibility:\s*"HOST"/);
  assert.match(propertyRouteSource, /projectMissionControlOperationalState\(operationalItems\)/);
  assert.match(propertyRouteSource, /mapHostActionQueueToRecommendedActions/);
  assert.match(propertyRouteSource, /activityHistory/);
});
'''
text = text[:left] + new
Path(path).write_bytes(text.encode('utf-8'))
print('Updated host-reporting contract only', path)

path = '.github/workflows/ota-airbnb-listing-discovery.yml'
text = load(path, 'ee046aa6e0857c45f0e47d466a1a14932e41be00')
anchor = '          if [ "${GITHUB_HEAD_REF:-$GITHUB_REF_NAME}" = "agent/property-protection-v1-guest-damage-response" ]; then\n'
addition = '''          if [ "${GITHUB_HEAD_REF:-$GITHUB_REF_NAME}" = "agent/mission-control-e13-decoupling-v1" ]; then
            cat > "$RUNNER_TEMP/mission-control-allowed.txt" <<'EOF'
          .github/workflows/mission-control-observational-certification.yml
          .github/workflows/ota-airbnb-listing-discovery.yml
          src/apms/mission-control-observational.test.ts
          src/apms/mission-control-observational.ts
          src/routes/dashboard.properties.route.ts
          src/services/guest-journey-e13-runtime-truth.contract.test.ts
          src/services/guest-journey-runtime-enforcement.contract.test.ts
          EOF
            sort "$RUNNER_TEMP/mission-control-allowed.txt" -o "$RUNNER_TEMP/mission-control-allowed.txt"
            diff -u "$RUNNER_TEMP/mission-control-allowed.txt" "$RUNNER_TEMP/actual.txt"
            exit 0
          fi

'''
text = once(text, anchor, addition + anchor)
Path(path).write_bytes(text.encode('utf-8'))
print('Added exact branch/file allowlist; every subsequent OTA test retained', path)
