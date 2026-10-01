import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
const source=fs.readFileSync(new URL("../routes/cleaning-confirm.routes.ts",import.meta.url),"utf8");
test("cleaner timing pages render with property timezone",()=>{assert.match(source,/property\?\.timezone \?\? "UTC"/);assert.match(source,/Intl\.DateTimeFormat\(getStaffIntlLocale\(language\)/);assert.match(source,/timeZoneName: "short"/);assert.match(source,/formatPropertyLocal\(prepared\.terms\.scheduledStartAt, prepared\.timeZone, language\)/);});
test("all new cleaner timing lifecycle timestamps avoid direct UTC rendering",()=>{assert.doesNotMatch(source,/formatUtc\(/);for(const value of ["accepted.timingConsentAcceptedAt!","started.startConfirmedAt!","completedAt"])assert.ok(source.includes("formatPropertyLocal("+value+", prepared.timeZone, language)"));});
