import { randomInt } from "node:crypto";
import { decryptAccessCode, encryptAccessCode } from "./access-code-crypto.service";
import { ttlockCreatePasscode, ttlockGetPasscode, ttlockHasAssociatedGateway,
  ttlockListPasscodes, TTLockPasscodeError } from "../ttlock/ttlock.passcode";

export type CustomPasscodePlan = {
  version: 1; state: "READY" | "SUBMITTED" | "CONFIRMED";
  codeEnc: string; source: "PHONE_LAST4" | "PHONE_LAST4_SUFFIX" | "RANDOM";
  rejectedCodeEncs?: string[];
  lockId: number; name: string; startDate: number; endDate: number;
  submittedAt?: string; keyboardPwdId?: number;
};

const defaults = { gateway: ttlockHasAssociatedGateway, list: ttlockListPasscodes,
  custom: ttlockCreatePasscode, timed: ttlockGetPasscode,
  random: () => String(randomInt(10_000_000, 100_000_000)) };

export function guestPhoneLastFour(phone: string | null | undefined): string | null {
  const value = String(phone ?? "").trim().replace(/\s*(?:ext\.?|x|#)\s*\d+$/i, "");
  if (!/^[+\d().\s-]+$/.test(value)) return null;
  const digits = value.replace(/\D/g, "");
  return digits.length >= 7 && digits.length <= 15 ? digits.slice(-4) : null;
}

function retry(reason: string): never {
  throw new Error(`GUEST_ACCESS_PROVISION_SAFE_TO_RETRY:${reason}`);
}

// The caller serializes provisioning per lock. Candidate state is committed
// before the hardware request; an uncertain result never chooses another PIN.
export async function provisionGuestPasscode(input: {
  lockId: number; accessToken: string; name: string; startDate: number; endDate: number;
  phone: string | null; mappedGateway: boolean; requireGateway: boolean;
  savedPlan: unknown;
  rearmedAt?: string;
  savePlan: (plan: CustomPasscodePlan) => Promise<void>;
  codeReserved: (code: string) => Promise<boolean>;
}, deps = defaults) {
  const startedAt = Date.now();
  let plan = input.savedPlan as CustomPasscodePlan | null | undefined;
  if (plan && (plan.version !== 1 || !["READY", "SUBMITTED", "CONFIRMED"].includes(plan.state) ||
    typeof plan.codeEnc !== "string" || plan.lockId !== input.lockId || plan.name !== input.name ||
    plan.startDate !== input.startDate || plan.endDate !== input.endDate)) {
    throw new Error("CUSTOM_PASSCODE_PLAN_REQUIRES_RECONCILIATION");
  }
  if (!plan) {
    let hasGateway: boolean;
    try { hasGateway = await deps.gateway(input); }
    catch { return retry("GATEWAY_PRESENCE_UNCONFIRMED"); }
    if (!hasGateway && !input.mappedGateway && !input.requireGateway) {
      const pass = await deps.timed({ ...input, keyboardPwdType: 3 });
      return { ...pass, provisioningMethod: "RANDOM_TIMED" as const };
    }
    // A disconnected known gateway must not silently turn into a no-gateway lock.
    if (!hasGateway) return retry("GATEWAY_UNAVAILABLE");
  }

  let inventory: Awaited<ReturnType<typeof ttlockListPasscodes>>;
  try { inventory = await deps.list(input); }
  catch {
    if (plan && plan.state !== "READY") throw new Error("CUSTOM_PASSCODE_RESULT_AMBIGUOUS:INVENTORY_UNAVAILABLE");
    return retry("PASSCODE_INVENTORY_UNAVAILABLE");
  }
  let code = plan ? decryptAccessCode(plan.codeEnc) : guestPhoneLastFour(input.phone);
  if (plan && (!code || !/^\d{4,9}$/.test(code))) throw new Error("CUSTOM_PASSCODE_PLAN_INVALID");
  if (plan && plan.state !== "READY") {
    const matches = inventory.filter(p => p.keyboardPwd === code && p.keyboardPwdName === input.name &&
      p.keyboardPwdType === 3 && p.startDate === input.startDate && p.endDate === input.endDate &&
      (p.status === null || p.status === 1));
    if (matches.length === 1 && (!plan.keyboardPwdId || plan.keyboardPwdId === matches[0]!.keyboardPwdId)) {
      plan = { ...plan, state: "CONFIRMED", keyboardPwdId: matches[0]!.keyboardPwdId };
      await input.savePlan(plan);
      return { keyboardPwd: code!, keyboardPwdId: plan.keyboardPwdId!, provisioningMethod: "CUSTOM_GATEWAY" as const, codeSource: plan.source };
    }
    // Existing E15 reconciliation may rearm only after confirmed provider absence.
    if (plan.state === "SUBMITTED" && input.rearmedAt && plan.submittedAt &&
      Date.parse(input.rearmedAt) > Date.parse(plan.submittedAt) &&
      !inventory.some(p => p.keyboardPwd === code || p.keyboardPwdName === input.name)) {
      plan = { ...plan, state: "READY" };
      await input.savePlan(plan);
    } else throw new Error("CUSTOM_PASSCODE_RESULT_AMBIGUOUS:RECONCILIATION_REQUIRED");
  }

  let source: CustomPasscodePlan["source"] = plan?.source ?? (code ? "PHONE_LAST4" : "RANDOM");
  const phoneBase = plan ? (plan.source === "RANDOM" ? null : code!.slice(0, 4)) : guestPhoneLastFour(input.phone);
  const rejectedCodeEncs = [...(plan?.rejectedCodeEncs ?? [])];
  const rejectedCodes = new Set(rejectedCodeEncs.map(decryptAccessCode));
  const available = async (candidate: string) => !rejectedCodes.has(candidate) &&
    !inventory.some(p => p.keyboardPwd === candidate) && !await input.codeReserved(candidate);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!code || !await available(code)) {
      code = null;
      if (phoneBase) {
        for (const candidate of [phoneBase, ...Array.from({ length: 10 }, (_, digit) => `${phoneBase}${digit}`)]) {
          if (await available(candidate)) {
            code = candidate;
            source = candidate.length === 4 ? "PHONE_LAST4" : "PHONE_LAST4_SUFFIX";
            break;
          }
        }
      }
      for (let candidateAttempt = 0; !code && candidateAttempt < 10; candidateAttempt++) {
        const candidate = deps.random();
        if (/^\d{4,9}$/.test(candidate) && await available(candidate)) {
          code = candidate; source = "RANDOM"; break;
        }
      }
      if (!code) return retry("CUSTOM_PASSCODE_NO_FREE_CANDIDATE");
    }
    plan = { version: 1, state: "READY", codeEnc: encryptAccessCode(code), source,
      ...(rejectedCodeEncs.length ? { rejectedCodeEncs: [...rejectedCodeEncs] } : {}),
      lockId: input.lockId, name: input.name, startDate: input.startDate, endDate: input.endDate };
    await input.savePlan(plan);
    // Stay inside the existing 30-second physical fence, including read calls.
    if (Date.now() - startedAt > 10_000) return retry("CUSTOM_PASSCODE_READ_BUDGET_EXHAUSTED");
    plan = { ...plan, state: "SUBMITTED", submittedAt: new Date().toISOString() };
    await input.savePlan(plan);
    try {
      const response = await deps.custom({ ...input, code, addType: 2, timeoutMs: 15_000 });
      const keyboardPwdId = Number(response?.keyboardPwdId);
      if (!Number.isInteger(keyboardPwdId) || keyboardPwdId <= 0) throw new Error("CUSTOM_PASSCODE_RESPONSE_INCOMPLETE");
      plan = { ...plan, state: "CONFIRMED", keyboardPwdId };
      await input.savePlan(plan);
      return { keyboardPwd: code, keyboardPwdId, provisioningMethod: "CUSTOM_GATEWAY" as const, codeSource: source };
    } catch (error) {
      const rejected = error instanceof TTLockPasscodeError && error.errcode !== null && error.errcode !== 0;
      const duplicate = rejected && /(?:passcode|password).*(?:already exists|already exist)|same (?:passcode|password).*exists/i.test(error.providerMessage);
      if (duplicate) {
        // Provider explicitly rejected this candidate. Never delete someone else's PIN.
        rejectedCodes.add(code);
        rejectedCodeEncs.push(plan.codeEnc);
        plan = { ...plan, state: "READY", rejectedCodeEncs: [...rejectedCodeEncs] };
        await input.savePlan(plan);
        code = null;
        continue;
      }
      if (rejected && [-2012, -3037, 10003, 10004, 30006].includes(error.errcode!)) {
        await input.savePlan({ ...plan, state: "READY" });
        return retry(`CUSTOM_PASSCODE_PROVIDER_REJECTED_${error.errcode}`);
      }
      // Do not expose provider messages, which can contain the supplied PIN.
      throw new Error("CUSTOM_PASSCODE_RESULT_AMBIGUOUS:RECONCILIATION_REQUIRED");
    }
  }
  return retry("CUSTOM_PASSCODE_CONFLICT_RETRIES_EXHAUSTED");
}
