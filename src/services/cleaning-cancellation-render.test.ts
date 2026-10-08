import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { renderCleaningCancellation } from "./cleaning-action-button.js";

const startsAt = new Date("2026-10-08T16:00:00Z");
const window = { startsAt, latestStartAt: new Date("2026-10-08T19:00:00Z"), latestCompletionAt: null };
test("portal cancellation is absent at/after the window start and when timing is unverified", () => {
  for (const now of [startsAt, new Date(startsAt.getTime() + 1)]) {
    assert.equal(renderCleaningCancellation({ token: "fixture", language: "es", window, now }), "");
  }
  assert.equal(renderCleaningCancellation({ token: "fixture", language: "es", window: null }), "");
});
test("already-open cancellation closes at the start and blocks form submission in both languages", () => {
  for (const language of ["es", "en"] as const) {
    const html = renderCleaningCancellation({ token: "fixture", language, window, now: new Date(startsAt.getTime() - 1000) });
    assert.match(html, language === "es" ? /Sí, cancelar limpieza/ : /Yes, cancel cleaning/);
    let elapsed = 0; let submit: (() => void) | undefined; let prevented = false;
    const button = { disabled: false };
    const details = { hidden: false, querySelector: (selector: string) => selector === "button" ? button : {
      addEventListener: (_name: string, handler: (e: { preventDefault(): void }) => void) => {
        submit = () => handler({ preventDefault: () => { prevented = true; } });
      },
    } };
    let tick: (() => void) | undefined;
    new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)![1]!).runInNewContext({
      document: { getElementById: () => details, addEventListener() {} },
      window: { addEventListener() {} }, performance: { now: () => elapsed },
      setInterval: (run: () => void) => { tick = run; },
    });
    assert.equal(details.hidden, false); assert.equal(button.disabled, false);
    elapsed = 1000; tick!(); submit!();
    assert.equal(details.hidden, true); assert.equal(button.disabled, true); assert.equal(prevented, true);
  }
});
