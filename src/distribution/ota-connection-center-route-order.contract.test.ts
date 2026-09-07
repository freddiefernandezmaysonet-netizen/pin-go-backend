import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const serverSource = readFileSync(
  new URL("../server.ts", import.meta.url),
  "utf8"
);

test("channel lifecycle transport is mounted before root authenticated routers", () => {
  const connectionCenter = serverSource.indexOf(
    "app.use(buildDashboardDistributionConnectionCenterRouter("
  );
  const propertiesRootRouter = serverSource.indexOf(
    "app.use(buildPropertiesRouter(prisma));"
  );
  const dashboardRootRouter = serverSource.indexOf("app.use(dashboardRouter);");

  assert.ok(connectionCenter >= 0, "Connection Center router must be mounted");
  assert.ok(propertiesRootRouter >= 0, "Properties root router must be mounted");
  assert.ok(dashboardRootRouter >= 0, "Dashboard root router must be mounted");
  assert.ok(connectionCenter < propertiesRootRouter);
  assert.ok(connectionCenter < dashboardRootRouter);
  assert.equal(
    serverSource.indexOf(
      "app.use(buildDashboardDistributionConnectionCenterRouter(",
      connectionCenter + 1
    ),
    -1,
    "Connection Center router must be mounted exactly once"
  );
});
