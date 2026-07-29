import assert from "node:assert/strict";
import test from "node:test";

import { runChannexAriDispatchCycle } from "./channex-ari-dispatch-cycle.service";

const NOW = new Date("2026-07-28T12:00:00.000Z");
const CREDENTIALS_SECRET = "secret-pms-credentials-key";
const GLOBAL_API_KEY = "secret-global-channex-key";

function selected