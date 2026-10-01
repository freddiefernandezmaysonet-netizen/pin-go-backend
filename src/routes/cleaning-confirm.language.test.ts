import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import express from "express";
import { PrismaClient } from "@prisma/client";
import { cleaningConfirmRouter } from "./cleaning-confirm.routes.js";

test("cleaner HTTP responses follow the staff language without writes", async t => {
  let language = "es";
  let status = "DECLINED";
  const prototype = PrismaClient.prototype as any;
  const originalRequest = prototype._request;
  prototype._request = async ({ model, action }: { model: string; action: string }) => {
    assert.equal(action, "findUnique", "the test must never write");
    if (model === "CleaningConfirmation") return { id: "confirmation", reservationId: "reservation", staffMemberId: "staff", status };
    if (model === "Reservation") return { id: "reservation", status: "ACTIVE", property: { cleaningNfcEnabled: true } };
    if (model === "StaffMember") return { id: "staff", preferredLanguage: language };
    throw new Error(`Unexpected model ${model}`);
  };
  const app = express();
  app.use(cleaningConfirmRouter);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/cleaning/confirm/test`;
  try {
    for (const selected of ["es", "en"]) {
      language = selected;
      await t.test(`${selected}: already declined`, async () => {
        const response = await fetch(base);
        assert.equal(response.status, 200);
        assert.equal(await response.text(), selected === "es" ? "Esta solicitud de limpieza ya fue rechazada." : "This cleaning request was already declined.");
      });
      for (const action of ["timing-consent", "start", "complete"]) {
        await t.test(`${selected}: ${action} requires availability`, async () => {
          const response = await fetch(`${base}/${action}`, { method: "POST" });
          assert.equal(response.status, 409);
          const body = await response.text();
          assert.match(body, selected === "es" ? /Confirma tu disponibilidad/ : /Confirm cleaning availability/);
          assert.doesNotMatch(body, selected === "es" ? /Confirm cleaning availability/ : /Confirma tu disponibilidad/);
        });
      }
    }
  } finally {
    prototype._request = originalRequest;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
