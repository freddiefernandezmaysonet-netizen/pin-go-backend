import assert from "node:assert/strict";
import test from "node:test";
import { assertCleaningTimingInvariant, CleaningTimingValidationError } from "./cleaning-timing-config.js";

test("accepts start grace strictly before duration",()=>assert.doesNotThrow(()=>assertCleaningTimingInvariant({currentDurationCommitmentMinutes:null,currentStartConfirmationGraceMinutes:30,update:{cleaningDurationCommitmentMinutes:30,cleaningStartConfirmationGraceMinutes:10}})));
test("rejects zero-width START_REMINDER window",()=>assert.throws(()=>assertCleaningTimingInvariant({currentDurationCommitmentMinutes:null,currentStartConfirmationGraceMinutes:30,update:{cleaningDurationCommitmentMinutes:30,cleaningStartConfirmationGraceMinutes:30}}),e=>e instanceof CleaningTimingValidationError&&e.field==="cleaningStartConfirmationGraceMinutes_must_be_less_than_duration"));
test("partial duration update is checked against persisted grace",()=>assert.throws(()=>assertCleaningTimingInvariant({currentDurationCommitmentMinutes:120,currentStartConfirmationGraceMinutes:30,update:{cleaningDurationCommitmentMinutes:20}}),CleaningTimingValidationError));
test("partial grace update is checked against persisted duration",()=>assert.throws(()=>assertCleaningTimingInvariant({currentDurationCommitmentMinutes:30,currentStartConfirmationGraceMinutes:10,update:{cleaningStartConfirmationGraceMinutes:30}}),CleaningTimingValidationError));
test("unconfigured duration keeps independent grace valid",()=>assert.doesNotThrow(()=>assertCleaningTimingInvariant({currentDurationCommitmentMinutes:null,currentStartConfirmationGraceMinutes:30,update:{cleaningStartConfirmationGraceMinutes:30}})));
