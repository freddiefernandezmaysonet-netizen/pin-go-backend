import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { confirmCleaningStart } from "./cleaning-work-start.prisma.js";
import { confirmCleaningCompletion } from "./cleaning-work-completion.prisma.js";
import { readCleaningActionWindow } from "./cleaning-action-window.js";
import { renderCleaningActionButton } from "./cleaning-action-button.js";
import { cleaningActionFixture } from "./cleaning-action-window.fixture.js";
const input = { workId: "work_1", reservationId: "res_1", staffMemberId: "staff_1", confirmationId: "conf_1" };
const seed = { id: "work_1", ...input, timingConsentVersion: "v1", timingConsentAcceptedAt: new Date("2026-09-28T14:00Z"), startConfirmedAt: null, completionConfirmedAt: null, cancelledAt: null, supersededAt: null };
const at = (time: string) => new Date(`2026-09-28T${time}Z`);
for (const [time, permitted] of [["15:29:59.999", false], ["15:30:00", true], ["19:29:59.999", true], ["19:30:00", false], ["20:00:00", false]] as const) {
  test(`start boundary ${time}: ${permitted}`, async () => {
    const f = cleaningActionFixture(seed);
    const before = { ...f.access };
    if (permitted) await confirmCleaningStart(f.db, input, at(time));
    else { await assert.rejects(confirmCleaningStart(f.db, input, at(time))); assert.equal(f.read().startConfirmedAt, null); }
    assert.deepEqual(f.access, before);
  });
}
for (const [time, permitted] of [["15:34:59.999", false], ["15:35:00", true], ["19:29:59.999", true], ["19:30:00", false], ["20:00:00", false]] as const) {
  test(`completion with next check-in boundary ${time}: ${permitted}`, async () => {
    const f = cleaningActionFixture({ ...seed, startConfirmedAt: at("15:35:00") });
    if (permitted) await confirmCleaningCompletion(f.db, input, at(time));
    else { await assert.rejects(confirmCleaningCompletion(f.db, input, at(time))); assert.equal(f.read().completionConfirmedAt, null); }
    assert.equal(f.access.status, "COMPLETED");
    assert.equal(f.access.endsAt.getTime(), at("19:30:00").getTime());
  });
}
test("without next check-in completion stays available after access expires, start does not", async () => {
  const f = cleaningActionFixture({ ...seed, startConfirmedAt: at("15:35:00") }, null);
  await confirmCleaningCompletion(f.db, input, at("22:00:00"));
  assert.equal(f.read().completionConfirmedAt.getTime(), at("22:00:00").getTime());
  await assert.rejects(confirmCleaningStart(cleaningActionFixture(seed, null).db, input, at("22:00:00")), /WINDOW_CLOSED/);
  assert.equal(f.access.endsAt.getTime(), at("19:30:00").getTime());
});
test("an earlier next check-in shortens both deadlines immediately", async () => {
  const f = cleaningActionFixture(seed, at("17:00:00"));
  const window = await readCleaningActionWindow(f.tx, f.read());
  assert.equal(window.latestStartAt.getTime(), at("17:00:00").getTime());
  assert.equal(window.latestCompletionAt?.getTime(), at("17:00:00").getTime());
  await assert.rejects(confirmCleaningStart(f.db, input, at("17:00:00")), /WINDOW_CLOSED/);
});
test("changed schedule rejects a stale work record", async () => {
  const f = cleaningActionFixture({ ...seed, scheduledStartAt: at("14:30:00") });
  await assert.rejects(confirmCleaningStart(f.db, input, at("16:00:00")), /SCHEDULE_CHANGED/);
});
test("access activation timing does not move the scheduled work start", async () => {
  const f = cleaningActionFixture(seed);
  f.access.startsAt = at("16:00:00");
  await confirmCleaningStart(f.db, input, at("15:30:00"));
  assert.equal(f.read().startConfirmedAt.getTime(), at("15:30:00").getTime());
  assert.equal(f.access.startsAt.getTime(), at("16:00:00").getTime());
});
test("button uses the same bounds and includes submit-time validation", async () => {
  const f = cleaningActionFixture(seed);
  const window = await readCleaningActionWindow(f.tx, f.read());
  const render = (now: Date) => renderCleaningActionButton({ token: "synthetic-token", action: "start", window, startedAt: null, language: "es", now });
  assert.match(render(at("15:29:59")), /class="cleaner-action" disabled/);
  assert.doesNotMatch(render(at("15:30:00")), /class="cleaner-action" disabled/);
  assert.match(render(at("19:30:00")), /class="cleaner-action" disabled/);
  assert.match(render(at("15:30:00")), /preventDefault/);
});
test("an already-open page enables at start and blocks a submit at closure", async () => {
  const f = cleaningActionFixture(seed);
  const window = await readCleaningActionWindow(f.tx, f.read());
  const rendered = renderCleaningActionButton({ token: "synthetic-token", action: "start", window, startedAt: null, language: "en", now: at("15:29:00") });
  const script = rendered.match(/<script>([\s\S]*)<\/script>/)![1]!;
  let elapsed = 0;
  let refresh: () => void = () => {};
  let submit: (event: { preventDefault(): void }) => void = () => {};
  const button = { disabled: true, form: { addEventListener: (_name: string, handler: typeof submit) => { submit = handler; } } };
  const note = { textContent: "" };
  runInNewContext(script, { document: { getElementById: (id: string) => id.endsWith("-note") ? note : button, addEventListener: () => {} }, window: { addEventListener: () => {} }, performance: { now: () => elapsed }, setInterval: (handler: typeof refresh) => { refresh = handler; } });
  assert.equal(button.disabled, true);
  elapsed = 60000; refresh();
  assert.equal(button.disabled, false);
  elapsed = at("19:30:00").getTime() - at("15:29:00").getTime();
  let prevented = false;
  submit({ preventDefault: () => { prevented = true; } });
  assert.equal(button.disabled, true);
  assert.equal(prevented, true);
});
