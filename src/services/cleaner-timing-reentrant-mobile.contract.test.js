import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
const source=fs.readFileSync(new URL("./cleaning-action-button.ts",import.meta.url),"utf8")+
fs.readFileSync(new URL("../routes/cleaning-confirm.routes.ts",import.meta.url),"utf8");
test("accepted timing GET remains inside mobile shell",()=>{assert.doesNotMatch(source,/return `Cleaning availability and timing commitment already confirmed/);assert.match(source,/Cleaning timing confirmed/);assert.ok(source.includes("I started cleaning"));});
test("same cleaner link exposes canonical next action by persisted state",()=>{assert.match(source,/if \(prepared\.work\.completionConfirmedAt\)/);assert.match(source,/if \(prepared\.work\.startConfirmedAt\)/);assert.match(source,/Cleaning in progress/);assert.match(source,/I finished cleaning/);assert.match(source,/Cleaning completed/);});
