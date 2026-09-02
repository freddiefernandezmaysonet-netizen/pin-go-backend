import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const mailer = await readFile(new URL("./mailer.ts", import.meta.url), "utf8");

test("reservation confirmation cannot render a review bearer", () => {
  const confirmation = mailer.slice(
    mailer.indexOf("export async function sendDirectBookingGuestConfirmation"),
    mailer.indexOf("export async function sendDirectBookingHostNotification")
  );
  assert.doesNotMatch(confirmation, /reviewUrl|safeReviewUrl|Review my stay|Evaluar mi estadía/);
});

test("dedicated review email validates and escapes its secure URL", () => {
  const invitation = mailer.slice(
    mailer.indexOf("export async function sendReviewInvitationEmail"),
    mailer.indexOf("type SendDirectBookingHostNotificationInput")
  );
  assert.match(invitation, /const safeUrl = getSafeReviewUrl\(input\.reviewUrl\)/);
  assert.match(invitation, /href="\$\{escapeHtml\(safeUrl\)\}"/);
  assert.match(invitation, /idempotencyKey: input\.idempotencyKey/);
});
