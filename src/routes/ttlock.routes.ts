// src/routes/ttlock.routes.ts
import crypto from "crypto";
import { Router } from "express";
import { PrismaClient } from "@prisma/client";
import { ttlockListLocks } from "../ttlock/ttlock.api";
import { ttlockGetAccessToken } from "../ttlock/ttlock.service";
import { ttlockCreatePasscode, ttlockGetPasscode } from "../ttlock/ttlock.passcode";
import { TTLockClient } from "../integrations/ttlock/ttlock.client";
import { sendSms } from "../integrations/twilio/twilio.client";

function maskCode(code: string, showLast = 2) {
  const s = String(code ?? "");
  if (!s) return "";
  if (s.length <= showLast) return "*".repeat(s.length);
  return "*".repeat(s.length - showLast) + s.slice(-showLast);
}

function hashCode(code: string) {
  return crypto.createHash("sha256").update(String(code)).digest("hex");
}

function getEncKey(): Buffer {
  const b64 = process.env.ACCESS_CODE_ENC_KEY_BASE64;
  if (!b64) throw new Error("Missing ACCESS_CODE_ENC_KEY_BASE64");
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error("ACCESS_CODE_ENC_KEY_BASE64 must decode to 32 bytes");
  return key;
}

function encryptCode(plain: string) {
  const key = getEncKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString("base64");
}

function decryptCode(payloadB64: string) {
  const key = getEncKey();
  const buf = Buffer.from(payloadB64, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);

  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);

  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString("utf8");
}


function lastNDigitsPhone(phone: string, n: number): string | null {
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length < n) return null;
  return digits.slice(-n);
}

function isWeakCode(code: string): boolean {
  return (
    /^(\d)\1+$/.test(code) || // 111111
    code === "123456" ||
    code === "654321" ||
    code === "000000"
  );
}

function randomDigits(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += Math.floor(Math.random() * 10).toString();
  return out;
}

function generatePinCode(opts: { phone?: string; digits?: number } = {}): string {
  const digits = opts.digits ?? 6;

  if (opts.phone) {
    const fromPhone = lastNDigitsPhone(opts.phone, digits);
    if (fromPhone && !isWeakCode(fromPhone)) return fromPhone;
  }

  for (let i = 0; i < 10; i++) {
    const c = randomDigits(digits);
    if (!isWeakCode(c)) return c;
  }

  return "482759";
}

function formatLocal(ms: number, timeZone = "America/Puerto_Rico") {
  // fallback si "America/Puerto_Rico" no existe en tu runtime:
  // usa "America/New_York" o "America/Santo_Domingo"
  try {
    return new Intl.DateTimeFormat("es-PR", {
      timeZone,
      weekday: "short",
      month: "short",
      day: "2-digit",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(ms));
  } catch {
    return new Intl.DateTimeFormat("es-PR", {
      timeZone: "America/New_York",
      weekday: "short",
      month: "short",
      day: "2-digit",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(ms));
  }
}


export function buildTTLockRouter(prisma: PrismaClient) {
  const router = Router();

  router.get("/token", async (_req, res) => {
    try {
      const token = await ttlockGetAccessToken();
      return res.json({
        ok: true,
        uid: token.uid,
        expires_in: token.expires_in,
        access_token_preview: token.access_token?.slice(0, 10) + "***",
      });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message ?? "token failed" });
    }
  });

  router.get("/locks", async (req, res) => {
    try {
      const pageNo = Number(req.query.pageNo ?? 1);
      const pageSize = Number(req.query.pageSize ?? 20);
      const data = await ttlockListLocks(pageNo, pageSize);
      return res.json({ ok: true, ...data });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message ?? "locks failed" });
    }
  });

  // ✅ passcode/get
  router.post("/passcode/get", async (req, res) => {
    try {
      const { lockId, type, name, hoursValid } = req.body ?? {};
      if (!lockId) return res.status(400).json({ ok: false, error: "Missing lockId" });

      const t = Number(type);
      if (![1, 2, 3].includes(t)) {
        return res.status(400).json({ ok: false, error: "type must be 1|2|3" });
      }

      const data = await ttlockGetPasscode({
        lockId: Number(lockId),
        keyboardPwdType: t as 1 | 2 | 3,
        name: name ? String(name) : undefined,
        hoursValid: hoursValid ? Number(hoursValid) : undefined,
      });

      return res.json({ ok: true, ...data });
    } catch (e: any) {
      return res.status(500).json({ ok: false, error: e?.message ?? "passcode/get failed" });
    }
  });

  router.post("/passcode/create", async (req, res) => {
    try {
      const { lockId, minutes, method, code, phone } = req.body ?? {};
      if (!lockId) return res.status(400).json({ ok: false, error: "Missing lockId" });

      const mins = Number(minutes ?? 60);
      const startDate = Date.now() - 30 * 1000; // robustez
      const endDate = Date.now() + mins * 60 * 1000;
      const expiresAt = new Date(endDate + 60 * 60 * 1000); // checkout + 1h

      const m = String(method ?? "custom").toLowerCase();
      let fallbackReason: any = null;

      const makeOtp = async () => {
        const otp = await ttlockGetPasscode({
        lockId: Number(lockId),
        keyboardPwdType: 1,
        name: "Pin&Go OTP",
        hoursValid: Math.max(1, Math.ceil(mins / 60)),
      });

      const accessCode = String((otp as any)?.keyboardPwd ?? "");
      const accessCodeMasked = maskCode(accessCode);
      const accessCodeHash = hashCode(accessCode);
      const accessCodeEnc = encryptCode(accessCode);

      await prisma.accessCode.create({
        data: {
          lockId: Number(lockId),
          method: "otp",
          accessCodeMasked,
          accessCodeHash,
          accessCodeEnc,
          expiresAt,
          keyboardPwdId: (otp as any)?.keyboardPwdId ? String((otp as any).keyboardPwdId) : null,
          startDate: BigInt(startDate),
          endDate: BigInt(endDate),
          phone: phone ? String(phone) : null,
        },
      });

    
      return res.json({
        ok: true,
        modeUsed: "otp",
        keyboardPwdType: 1,
        fallbackReason,
        accessCode,
        accessCodeMasked,
        ...otp,
        window: {
          startDate,
          endDate,
          startISO: new Date(startDate).toISOString(),
          endISO: new Date(endDate).toISOString(),
        },
      });
    };

    const makeCustom = async () => {
      const pin = code ? String(code) : generatePinCode({ phone, digits: 7 });

      const custom = await ttlockCreatePasscode({
        lockId: Number(lockId),
        code: pin,
        startDate,
        endDate,
        addType: 2,
        name: "Pin&Go Custom",
      });

      const accessCode = pin;
      const accessCodeMasked = maskCode(accessCode);
      const accessCodeHash = hashCode(accessCode);
      const accessCodeEnc = encryptCode(accessCode);

    function decryptCode(payloadB64: string) {
      const key = getEncKey();
      const buf = Buffer.from(payloadB64, "base64");
      const iv = buf.subarray(0, 12);
      const tag = buf.subarray(12, 28);
      const ciphertext = buf.subarray(28);

      const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAuthTag(tag);

      const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      return plain.toString("utf8");
    }

      await prisma.accessCode.create({
        data: {
          lockId: Number(lockId),
          method: "custom",
          accessCodeMasked,
          accessCodeHash,
          accessCodeEnc,
          expiresAt,
          keyboardPwdId: (custom as any)?.keyboardPwdId ? String((custom as any).keyboardPwdId) : null,
          startDate: BigInt(startDate),
          endDate: BigInt(endDate),
          phone: phone ? String(phone) : null,
        },
      });

      return res.json({
        ok: true,
        modeUsed: "custom",
        code: pin,
        accessCode,
        accessCodeMasked,
        ...custom,
        window: {
          startDate,
          endDate,
          startISO: new Date(startDate).toISOString(),
          endISO: new Date(endDate).toISOString(),
        },
      });
    };

    if (m === "otp") return await makeOtp();
    if (m === "custom") return await makeCustom();

    // auto: custom -> otp
    try {
      return await makeCustom();
    } catch (e: any) {
      fallbackReason = e?.response?.data || e?.message || String(e);
      return await makeOtp();
    }
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? "passcode/create failed" });
  }
});


// ===== Pin&Go: helpers para generar PIN automático (activar cuando estés listo) =====
/*
function lastNDigitsPhone(phone: string, n: number): string | null {
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length < n) return null;
  return digits.slice(-n);
}

function isWeakCode(code: string): boolean {
  return (
    /^(\d)\1+$/.test(code) || // 111111
    code === "123456" ||
    code === "654321" ||
    code === "000000"
  );
}

function randomDigits(n: number): string {
  let out = "";
  for (let i = 0; i < n; i++) out += Math.floor(Math.random() * 10).toString();
  return out;
}

function generatePinCode(opts: { phone?: string; digits?: number } = {}): string {
  const digits = opts.digits ?? 6;

  // 1) intenta derivarlo del teléfono (últimos N)
  if (opts.phone) {
    const fromPhone = lastNDigitsPhone(opts.phone, digits);
    if (fromPhone && !isWeakCode(fromPhone)) return fromPhone;
  }

  // 2) random fallback (evitar débiles)
  for (let i = 0; i < 10; i++) {
    const c = randomDigits(digits);
    if (!isWeakCode(c)) return c;
  }

  // 3) último recurso
  return "482759";
}
/*
// ===== end helpers =====

     // 2) FALLBACK AUTOMÁTICO: OTP (type 1 confirmado por tu lock)
   
      const otp = await ttlockGetPasscode({
      lockId: Number(lockId),
      keyboardPwdType: 1, // ✅ tu lock
      name: "Pin&Go OTP",
      hoursValid: Math.max(1, Math.ceil(mins / 60)),
    });

    return res.json({
      ok: true,
      mode: "otp",
      keyboardPwdType: 1,
      accessCode: otp.keyboardPwd,
      ...otp,
      window: {
        startDate,
        endDate,
        startISO: new Date(startDate).toISOString(),
        endISO: new Date(endDate).toISOString(),
      },
    });
   
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? "passcode/create failed" });
  }
});

 */

router.post("/passcode/resend", async (req, res) => {
  try {
    const { lockId, phone } = req.body ?? {};
    if (!lockId) return res.status(400).json({ ok: false, error: "Missing lockId" });

    const now = new Date();

    const row = await prisma.accessCode.findFirst({
      where: {
        lockId: Number(lockId),
        expiresAt: { gt: now },
        accessCodeEnc: { not: null },
      },
      orderBy: { createdAt: "desc" },
    });

    if (!row) {
      return res.status(404).json({
        ok: false,
        error: "No active access code found (expired or already cleaned).",
      });
    }

    const accessCode = decryptCode(row.accessCodeEnc as string);

    const toPhone = phone ?? row.phone;
    if (!toPhone) {
      return res.status(400).json({ ok: false, error: "No phone number available to send SMS." });
    }

    const message = `Pin&Go Access 🔐\nCódigo: ${accessCode}\nVálido hasta: ${row.expiresAt.toISOString()}`;

    const sms = await sendSms(toPhone, message);

    const isProd = process.env.NODE_ENV === "production";

    return res.json({
      ok: true,
      sent: true,
      lockId: row.lockId,
      method: row.method,
      accessCodeMasked: row.accessCodeMasked,
      expiresAt: row.expiresAt,
      phone: toPhone,
      twilio: sms,
      ...(isProd ? {} : { accessCode }),
    });
  } catch (e: any) {
    return res.status(500).json({ ok: false, error: e?.message ?? "passcode/resend failed" });
  }
});

   console.log("TTLOCK ROUTES LOADED ✅");
 
     return router;
   }

                                                                                                                                    