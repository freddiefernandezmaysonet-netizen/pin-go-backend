import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

test("server mounts TTLock callback after urlencoded parsing and before other form webhooks", async () => {
  const serverPath = fileURLToPath(
    new URL("../server.ts", import.meta.url)
  );
  const source = await readFile(serverPath, "utf8");

  const parserIndex = source.indexOf(
    "app.use(bodyParser.urlencoded({ extended: true }));"
  );
  const ttlockIndex = source.indexOf(
    "app.use(buildTtlockCallbackCanaryRouter(prisma, process.env));"
  );
  const messageWebhookIndex = source.indexOf(
    "app.use(buildMessageDeliveryWebhookRouter(prisma));"
  );

  assert.ok(parserIndex >= 0, "urlencoded parser must be mounted");
  assert.ok(ttlockIndex > parserIndex, "TTLock callback must follow form parsing");
  assert.ok(
    messageWebhookIndex > ttlockIndex,
    "TTLock callback must remain isolated before downstream webhook routers"
  );
});
