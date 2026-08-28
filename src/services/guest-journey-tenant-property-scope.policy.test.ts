import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertGuestJourneyTenantPropertyScope,
  buildGuestJourneyCoordinationIntentScopeWhere,
  buildGuestJourneyReservationScopeWhere,
  isGuestJourneyTenantPropertyScope,
  normalizeGuestJourneyTenantPropertyScope,
} from "./guest-journey-tenant-property-scope.policy.js";
import {
  resolveGuestJourneyActivationControlPlaneConfig,
} from "./guest-journey-activation-control-plane.service.js";
import {
  isGuestJourneyAccessOwnerScope,
  resolveGuestJourneyAccessOwnerConfig,
} from "./guest-journey-access-owner.config.js";
import {
  verifyGuestJourneyRuntimeScope,
} from "./guest-journey-runtime-enforcement.service.js";

const ORGANIZATION_A = "organization-a";
const ORGANIZATION_B = "organization-b";
const PROPERTY_A = "property-a";
const PROPERTY_B = "property-b";

function shadowProfileEnv(input: {
  organizationIds?: string;
  propertyIds?: string;
}): NodeJS.ProcessEnv {
  return {
    GUEST_JOURNEY_APMS_ACTIVATION_PROFILE:
      "shadow_only",
    GUEST_JOURNEY_SHADOW_ENABLED: "true",
    ...(input.organizationIds
      ? {
          GUEST_JOURNEY_SHADOW_ORGANIZATION_IDS:
            input.organizationIds,
        }
      : {}),
    ...(input.propertyIds
      ? {
          GUEST_JOURNEY_SHADOW_PROPERTY_IDS:
            input.propertyIds,
        }
      : {}),
  };
}

function read(relativePath: string): string {
  return readFileSync(
    new URL(relativePath, import.meta.url),
    "utf8"
  );
}

test(
  "tenant scope is organization-rooted and property scope is an optional subset",
  () => {
    assert.deepEqual(
      normalizeGuestJourneyTenantPropertyScope({
        organizationIds: [
          ORGANIZATION_B,
          ORGANIZATION_A,
          ORGANIZATION_A,
        ],
        propertyIds: [
          PROPERTY_B,
          PROPERTY_A,
          PROPERTY_A,
        ],
      }),
      {
        organizationIds: [
          ORGANIZATION_A,
          ORGANIZATION_B,
        ],
        propertyIds: [
          PROPERTY_A,
          PROPERTY_B,
        ],
      }
    );

    assert.doesNotThrow(() =>
      assertGuestJourneyTenantPropertyScope({
        enabled: false,
        scope: {
          organizationIds: [],
          propertyIds: [PROPERTY_A],
        },
        errorCode: "SCOPE_REQUIRED",
      })
    );

    assert.throws(
      () =>
        assertGuestJourneyTenantPropertyScope({
          enabled: true,
          scope: {
            organizationIds: [],
            propertyIds: [PROPERTY_A],
          },
          errorCode: "SCOPE_REQUIRED",
        }),
      /SCOPE_REQUIRED/
    );

    const organizationWide = {
      organizationIds: [ORGANIZATION_A],
      propertyIds: [],
    };
    assert.equal(
      isGuestJourneyTenantPropertyScope(
        organizationWide,
        {
          organizationId: ORGANIZATION_A,
          propertyId: PROPERTY_A,
        }
      ),
      true
    );
    assert.equal(
      isGuestJourneyTenantPropertyScope(
        organizationWide,
        {
          organizationId: ORGANIZATION_B,
          propertyId: PROPERTY_A,
        }
      ),
      false
    );

    const propertySubset = {
      organizationIds: [ORGANIZATION_A],
      propertyIds: [PROPERTY_A],
    };
    assert.equal(
      isGuestJourneyTenantPropertyScope(
        propertySubset,
        {
          organizationId: ORGANIZATION_A,
          propertyId: PROPERTY_A,
        }
      ),
      true
    );
    assert.equal(
      isGuestJourneyTenantPropertyScope(
        propertySubset,
        {
          organizationId: ORGANIZATION_A,
          propertyId: PROPERTY_B,
        }
      ),
      false
    );
    assert.equal(
      isGuestJourneyTenantPropertyScope(
        propertySubset,
        {
          organizationId: ORGANIZATION_B,
          propertyId: PROPERTY_A,
        }
      ),
      false
    );
  }
);

test(
  "Prisma selectors enforce organization AND optional property subset",
  () => {
    assert.deepEqual(
      buildGuestJourneyReservationScopeWhere({
        organizationIds: [ORGANIZATION_A],
        propertyIds: [],
      }),
      {
        property: {
          is: {
            organizationId: {
              in: [ORGANIZATION_A],
            },
          },
        },
      }
    );

    const reservationScope =
      buildGuestJourneyReservationScopeWhere({
        organizationIds: [ORGANIZATION_A],
        propertyIds: [PROPERTY_A],
      });

    assert.deepEqual(reservationScope, {
      property: {
        is: {
          organizationId: {
            in: [ORGANIZATION_A],
          },
        },
      },
      propertyId: {
        in: [PROPERTY_A],
      },
    });

    assert.deepEqual(
      buildGuestJourneyCoordinationIntentScopeWhere({
        organizationIds: [ORGANIZATION_A],
        propertyIds: [PROPERTY_A],
      }),
      {
        reservation: {
          is: reservationScope,
        },
      }
    );

    assert.throws(
      () =>
        buildGuestJourneyReservationScopeWhere({
          organizationIds: [],
          propertyIds: [PROPERTY_A],
        }),
      /TENANT_ORGANIZATION_SCOPE_REQUIRED/
    );
  }
);

test(
  "activation control plane rejects property-only activation and accepts hierarchical scopes",
  () => {
    assert.throws(
      () =>
        resolveGuestJourneyActivationControlPlaneConfig(
          shadowProfileEnv({
            propertyIds: PROPERTY_A,
          })
        ),
      /SCOPE_REQUIRED/
    );

    const organizationWide =
      resolveGuestJourneyActivationControlPlaneConfig(
        shadowProfileEnv({
          organizationIds: ORGANIZATION_A,
        })
      );
    assert.deepEqual(
      organizationWide.scope,
      {
        organizationIds: [ORGANIZATION_A],
        propertyIds: [],
      }
    );

    const propertySubset =
      resolveGuestJourneyActivationControlPlaneConfig(
        shadowProfileEnv({
          organizationIds: ORGANIZATION_A,
          propertyIds: PROPERTY_A,
        })
      );
    assert.deepEqual(
      propertySubset.scope,
      {
        organizationIds: [ORGANIZATION_A],
        propertyIds: [PROPERTY_A],
      }
    );
  }
);

test(
  "runtime preflight verifies property ownership inside the authorized tenant",
  async () => {
    const organizationWide =
      resolveGuestJourneyActivationControlPlaneConfig(
        shadowProfileEnv({
          organizationIds: ORGANIZATION_A,
        })
      );
    const propertySubset =
      resolveGuestJourneyActivationControlPlaneConfig(
        shadowProfileEnv({
          organizationIds: ORGANIZATION_A,
          propertyIds: PROPERTY_A,
        })
      );
    const crossTenantProperty =
      resolveGuestJourneyActivationControlPlaneConfig(
        shadowProfileEnv({
          organizationIds: ORGANIZATION_A,
          propertyIds: PROPERTY_B,
        })
      );

    const prisma = {
      organization: {
        findMany: async ({ where }: any) =>
          where.id.in
            .filter((id: string) =>
              [
                ORGANIZATION_A,
                ORGANIZATION_B,
              ].includes(id)
            )
            .map((id: string) => ({ id })),
      },
      property: {
        findMany: async ({ where }: any) =>
          where.id.in
            .filter((id: string) =>
              [PROPERTY_A, PROPERTY_B]
                .includes(id)
            )
            .map((id: string) => ({
              id,
              organizationId:
                id === PROPERTY_A
                  ? ORGANIZATION_A
                  : ORGANIZATION_B,
            })),
      },
    };

    await assert.doesNotReject(() =>
      verifyGuestJourneyRuntimeScope(
        prisma,
        organizationWide
      )
    );
    await assert.doesNotReject(() =>
      verifyGuestJourneyRuntimeScope(
        prisma,
        propertySubset
      )
    );
    await assert.rejects(
      () =>
        verifyGuestJourneyRuntimeScope(
          prisma,
          crossTenantProperty
        ),
      /TENANT_PROPERTY_SCOPE_MISMATCH/
    );

    await assert.rejects(
      () =>
        verifyGuestJourneyRuntimeScope(
          prisma,
          {
            ...organizationWide,
            scope: {
              organizationIds: [],
              propertyIds: [PROPERTY_A],
            },
          }
        ),
      /ORGANIZATION_SCOPE_REQUIRED/
    );
  }
);

test(
  "legacy access yield inherits the same hierarchical tenant/property rule",
  () => {
    assert.throws(
      () =>
        resolveGuestJourneyAccessOwnerConfig({
          GUEST_JOURNEY_ACCESS_OWNER_EXECUTE:
            "true",
          GUEST_JOURNEY_ACCESS_OWNER_PROPERTY_IDS:
            PROPERTY_A,
        }),
      /SCOPE_REQUIRED/
    );

    const organizationWide =
      resolveGuestJourneyAccessOwnerConfig({
        GUEST_JOURNEY_ACCESS_OWNER_EXECUTE:
          "true",
        GUEST_JOURNEY_ACCESS_OWNER_ORGANIZATION_IDS:
          ORGANIZATION_A,
      });
    assert.equal(
      isGuestJourneyAccessOwnerScope(
        organizationWide,
        {
          organizationId: ORGANIZATION_A,
          propertyId: PROPERTY_B,
        }
      ),
      true
    );

    const propertySubset =
      resolveGuestJourneyAccessOwnerConfig({
        GUEST_JOURNEY_ACCESS_OWNER_EXECUTE:
          "true",
        GUEST_JOURNEY_ACCESS_OWNER_ORGANIZATION_IDS:
          ORGANIZATION_A,
        GUEST_JOURNEY_ACCESS_OWNER_PROPERTY_IDS:
          PROPERTY_A,
      });
    assert.equal(
      isGuestJourneyAccessOwnerScope(
        propertySubset,
        {
          organizationId: ORGANIZATION_A,
          propertyId: PROPERTY_A,
        }
      ),
      true
    );
    assert.equal(
      isGuestJourneyAccessOwnerScope(
        propertySubset,
        {
          organizationId: ORGANIZATION_A,
          propertyId: PROPERTY_B,
        }
      ),
      false
    );
    assert.equal(
      isGuestJourneyAccessOwnerScope(
        propertySubset,
        {
          organizationId: ORGANIZATION_B,
          propertyId: PROPERTY_A,
        }
      ),
      false
    );
  }
);

test(
  "all APMS stages, claims, Mission Control and legacy guards use the shared hierarchy",
  () => {
    const configFiles = [
      "guest-journey-shadow.config.ts",
      "guest-journey-internal-reconcile.config.ts",
      "guest-journey-coordination.config.ts",
      "guest-journey-owner-runtime.config.ts",
      "guest-journey-mission-control.config.ts",
      "guest-journey-communications-owner.config.ts",
      "guest-journey-access-owner.config.ts",
      "guest-journey-financial-owner.config.ts",
      "guest-journey-compliance-owner.config.ts",
    ];

    for (const file of configFiles) {
      assert.match(
        read(`./${file}`),
        /assertGuestJourneyTenantPropertyScope/
      );
    }

    const reservationCycles = [
      "guest-journey-shadow-cycle.service.ts",
      "guest-journey-engine-cycle.service.ts",
      "guest-journey-coordination-cycle.service.ts",
    ];

    for (const file of reservationCycles) {
      const source = read(`./${file}`);
      assert.match(
        source,
        /buildGuestJourneyReservationScopeWhere/
      );
      assert.doesNotMatch(
        source,
        /OR:\s*scopes/
      );
    }

    const intentCycles = [
      "guest-journey-owner-runtime-cycle.service.ts",
      "guest-journey-mission-control-cycle.service.ts",
      "guest-journey-communications-owner-cycle.service.ts",
      "guest-journey-access-owner-cycle.service.ts",
      "guest-journey-financial-owner-cycle.service.ts",
      "guest-journey-compliance-owner-cycle.service.ts",
    ];

    for (const file of intentCycles) {
      const source = read(`./${file}`);
      assert.match(
        source,
        /buildGuestJourneyCoordinationIntentScopeWhere/
      );
      assert.doesNotMatch(
        source,
        /OR:\s*scopeFilters/
      );
      assert.doesNotMatch(
        source,
        /OR:\s*buildScopeFilters/
      );
    }

    const claimFiles = [
      "guest-journey-owner-runtime.service.ts",
      "guest-journey-communications-owner-runtime.service.ts",
      "guest-journey-access-owner-runtime.service.ts",
      "guest-journey-financial-owner-runtime.service.ts",
      "guest-journey-compliance-owner-runtime.service.ts",
    ];

    for (const file of claimFiles) {
      const source = read(`./${file}`);
      assert.match(
        source,
        /isGuestJourneyTenantPropertyScope/
      );
      assert.doesNotMatch(
        source,
        /organizationIds\.includes\(organizationId\)[\s\S]{0,80}\|\|[\s\S]{0,80}propertyIds\.includes\(propertyId\)/
      );
    }

    const missionControlCycle = read(
      "./guest-journey-mission-control-cycle.service.ts"
    );
    assert.match(
      missionControlCycle,
      /isGuestJourneyTenantPropertyScope/
    );

    const runtimeState = read(
      "./guest-journey-runtime-state.service.ts"
    );
    assert.match(
      runtimeState,
      /if \(!organizationMatches\) return false/
    );
    assert.match(
      runtimeState,
      /if \(propertyHashes\.length === 0\) return true/
    );
    assert.doesNotMatch(
      runtimeState,
      /organizationHashes\.includes\([\s\S]{0,180}\|\|[\s\S]{0,180}propertyHashes\.includes/
    );

    const ownerConfigs = [
      "guest-journey-access-owner.config.ts",
      "guest-journey-financial-owner.config.ts",
      "guest-journey-compliance-owner.config.ts",
      "guest-journey-communications-owner.config.ts",
    ];

    for (const file of ownerConfigs) {
      assert.match(
        read(`./${file}`),
        /isGuestJourneyTenantPropertyScope/
      );
    }

    const legacyGuards = [
      [
        "../workers/reservation.worker.ts",
        "isGuestJourneyAccessOwnerScope",
      ],
      [
        "../workers/access-grant-expire.worker.ts",
        "isGuestJourneyAccessOwnerScope",
      ],
      [
        "../workers/passcode-expire.worker.ts",
        "isGuestJourneyAccessOwnerScope",
      ],
      [
        "../routes/access.nfc.routes.ts",
        "isGuestJourneyAccessOwnerScope",
      ],
      [
        "../workers/message.retry.worker.ts",
        "isGuestJourneyCommunicationsOwnerScope",
      ],
    ] as const;

    for (const [file, marker] of legacyGuards) {
      assert.ok(read(file).includes(marker));
    }
  }
);
