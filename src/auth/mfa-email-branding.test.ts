import assert from "node:assert/strict";
import test from "node:test";
import { deliverMfaEmailOtp } from "./mfa-email-otp-delivery.js";

test("MFA email uses Pin&Go branded bilingual layout", async () => {
  let captured: { subject?: string; html?: string } = {};

  const result = await deliverMfaEmailOtp(
    {
      destination: "host@example.com",
      code: "654321",
      expiresInMinutes: 5,
    },
    {
      env: {
        PINGO_MFA_EMAIL_DELIVERY: "RESEND",
        RESEND_API_KEY: "test-key",
        EMAIL_FROM: "Pin&Go <security@example.com>",
      },
      sender: async (input) => {
        captured = {
          subject: input.subject,
          html: input.html,
        };
        return { providerMessageId: "msg-branding" };
      },
    }
  );

  assert.equal(result.delivered, true);
  assert.match(captured.subject ?? "", /Tu código de seguridad de Pin&Go/);
  assert.match(captured.subject ?? "", /Your Pin&Go security code/);

  const html = captured.html ?? "";
  assert.match(html, /PIN&amp;GO SECURITY/);
  assert.match(html, /linear-gradient\(135deg,#020617,#1d4ed8\)/);
  assert.match(html, /C&Oacute;DIGO DE SEGURIDAD \/ SECURITY CODE/);
  assert.match(html, /654321/);
  assert.match(html, /lang="es"/);
  assert.match(html, /ESPA&Ntilde;OL/);
  assert.match(html, /Confirma tu inicio de sesi&oacute;n/);
  assert.match(html, /Expira en 5 minutos/);
  assert.match(html, /lang="en"/);
  assert.match(html, /ENGLISH/);
  assert.match(html, /Confirm your sign-in/);
  assert.match(html, /Expires in 5 minutes/);
  assert.match(html, /never ask you for this code by phone, SMS, or chat/);
});
