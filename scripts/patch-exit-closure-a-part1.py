from pathlib import Path


def replace_once(path: str, old: str, new: str, code: str) -> None:
    p = Path(path)
    text = p.read_text(encoding='utf-8')
    count = text.count(old)
    if count != 1:
        raise SystemExit(f'{code}: expected 1 anchor, found {count}')
    p.write_text(text.replace(old, new, 1), encoding='utf-8')


def insert_after(path: str, anchor: str, addition: str, code: str) -> None:
    replace_once(path, anchor, anchor + addition, code)
# ---------------------------------------------------------------------------
# E8 Access Owner -> E14.1 reservation-level provider boundary.
# ---------------------------------------------------------------------------
adapter = 'src/services/guest-journey-access-owner-adapter.service.ts'
insert_after(
    adapter,
    'import {\n  isGuestJourneyAccessClosureSatisfied,\n} from "./guest-journey-contract";\n',
    'import {\n  executeGuestAccessProvisioningWithFence,\n} from "../e14/guest-access-admission-fence.service.e14";\n'
    'import {\n  evaluateGuestAccessReadiness,\n} from "./guest-access-readiness.service";\n'
    'import {\n  buildGuestJourneyAccessOwnerE14OwnerId,\n  mapGuestJourneyAccessOwnerE14ProvisionResult,\n} from "./guest-access-exit-closure-a.policy";\n',
    'EXIT_A_ADAPTER_IMPORT_ANCHOR',
)
replace_once(
    adapter,
    '  assertTenantProviderAuth: typeof assertOrgTtlockAuthConfigured;\n};\n',
    '  assertTenantProviderAuth: typeof assertOrgTtlockAuthConfigured;\n'
    '  executeProvisioningFence: typeof executeGuestAccessProvisioningWithFence;\n'
    '  evaluateReadiness: typeof evaluateGuestAccessReadiness;\n};\n',
    'EXIT_A_ADAPTER_DEP_TYPE_ANCHOR',
)
replace_once(
    adapter,
    '  assertTenantProviderAuth: assertOrgTtlockAuthConfigured,\n};\n',
    '  assertTenantProviderAuth: assertOrgTtlockAuthConfigured,\n'
    '  executeProvisioningFence: executeGuestAccessProvisioningWithFence,\n'
    '  evaluateReadiness: evaluateGuestAccessReadiness,\n};\n',
    'EXIT_A_ADAPTER_DEFAULT_DEP_ANCHOR',
)
old_provider = '''  try {\n    const activation = await withProviderTimeout(\n      dependencies.activate(grant.id),\n      providerTimeoutMs\n    );\n    if ((activation as any)?.ok !== true && !(activation as any)?.skipped) {\n      throw new Error(`ACCESS_PROVISIONING_CANONICAL_ACTIVATION_FAILED:${(activation as any)?.reason ?? "UNKNOWN"}`);\n    }\n  } catch (error) {\n    const normalized = normalizedError(error);\n    return {\n      kind: isAmbiguousProviderError(error) ? "AMBIGUOUS" : "RETRYABLE",\n      errorCode: isAmbiguousProviderError(error)\n        ? "ACCESS_PROVISIONING_PROVIDER_RESULT_AMBIGUOUS"\n        : normalized.code,\n      errorDetail: normalized.detail,\n      accessGrantIds: [grant.id],\n    };\n  }\n'''
new_provider = '''  const fencedProvision =\n    await dependencies.executeProvisioningFence(\n      prisma,\n      {\n        accessGrantId: grant.id,\n        reservationId: claim.reservationId,\n        ownerId: buildGuestJourneyAccessOwnerE14OwnerId({\n          intentId: claim.intentId,\n          attemptNumber: claim.attemptNumber,\n        }),\n        now,\n        physicalTimeoutMs: providerTimeoutMs,\n        evaluateReadiness: async (reservationId, evaluatedAt) =>\n          dependencies.evaluateReadiness(\n            prisma,\n            reservationId,\n            {\n              persist: true,\n              now: evaluatedAt,\n              expectedScope: {\n                organizationId: claim.organizationId,\n                propertyId: claim.propertyId,\n              },\n            }\n          ),\n        executePhysical: () => dependencies.activate(grant.id),\n      }\n    );\n  const fencedDecision =\n    mapGuestJourneyAccessOwnerE14ProvisionResult(\n      fencedProvision,\n      grant.id\n    );\n  if (!fencedDecision.proceed) {\n    return fencedDecision.completion;\n  }\n'''
replace_once(adapter, old_provider, new_provider, 'EXIT_A_ADAPTER_PROVIDER_ANCHOR')

# Preserve old adapter unit fakes by injecting a deterministic fake E14 boundary.
adapter_test = 'src/services/guest-journey-access-owner-adapter.service.test.ts'
replace_once(
    adapter_test,
    '    assignNfc: async () => [],\n    ...overrides,\n',
    '''    assignNfc: async () => [],\n    evaluateReadiness: async () => ({ ready: true }),\n    executeProvisioningFence: async (_prisma: unknown, input: any) => {\n      const readiness = await input.evaluateReadiness(\n        input.reservationId,\n        now\n      );\n      if (!readiness.ready) {\n        return {\n          status: "WAITING_FOR_EVIDENCE",\n          reason: "CANONICAL_ACCESS_READINESS_NOT_ELIGIBLE",\n          attemptCount: 1,\n        };\n      }\n\n      let timer: ReturnType<typeof setTimeout> | undefined;\n      try {\n        const activation = await Promise.race([\n          input.executePhysical(),\n          new Promise<never>((_resolve, reject) => {\n            timer = setTimeout(\n              () => reject(new Error("GUEST_ACCESS_PROVISION_RESULT_AMBIGUOUS_TIMEOUT")),\n              input.physicalTimeoutMs\n            );\n          }),\n        ]);\n        return {\n          status: "SUCCEEDED",\n          activation,\n          fenceCleared: true,\n          attemptCount: 1,\n        };\n      } catch (error) {\n        return {\n          status: "AMBIGUOUS",\n          reason: error instanceof Error ? error.message : String(error),\n          attemptCount: 1,\n        };\n      } finally {\n        if (timer) clearTimeout(timer);\n      }\n    },\n    ...overrides,\n''',
    'EXIT_A_ADAPTER_TEST_DEP_ANCHOR',
)

# ---------------------------------------------------------------------------
# E15.1 late-success closure under Reservation + AccessGrant locks.
# ---------------------------------------------------------------------------
e151 = 'src/e15/guest-access-reservation-reconciliation-fence.e15-1.ts'
replace_once(
    e151,
    'export type RearmAmbiguousGrantE15_1Input = ExpectedGrantSnapshot & {\n  now: Date;\n  payload: Prisma.InputJsonValue;\n};\n',
    'export type RearmAmbiguousGrantE15_1Input = ExpectedGrantSnapshot & {\n  now: Date;\n  payload: Prisma.InputJsonValue;\n};\n\n'
    'export type ReconcileLateProviderSuccessE15_1Input =\n  ExpectedGrantSnapshot & {\n    now: Date;\n    providerKeyboardPwdId: number;\n    payload: Prisma.InputJsonValue;\n  };\n',
    'EXIT_A_E151_TYPE_ANCHOR',
)
anchor_find = '''function findCanonicalPendingTarget(\n  reservation: ReservationFenceSnapshot,\n  input: ExpectedGrantSnapshot\n): ReservationFenceGrant | null {\n  const canonical = reservation.accessGrants.filter((grant) =>\n    grant.status === AccessStatus.PENDING &&\n    sameInstant(grant.startsAt, reservation.checkIn) &&\n    sameInstant(grant.endsAt, reservation.checkOut)\n  );\n  if (canonical.length !== 1 || canonical[0].id !== input.grantId) {\n    return null;\n  }\n\n  const target = canonical[0];\n  if (\n    target.recoveryOperation !== GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS ||\n    target.recoveryAttemptCount !== input.recoveryAttemptCount ||\n    !sameInstant(target.updatedAt, input.updatedAt) ||\n    !sameInstant(target.startsAt, input.startsAt) ||\n    !sameInstant(target.endsAt, input.endsAt) ||\n    positiveTtlockLockId(target) !== input.ttlockLockId\n  ) {\n    return null;\n  }\n\n  for (const sibling of reservation.accessGrants) {\n    if (sibling.id === target.id) continue;\n    if (isBlockingSibling(sibling)) return null;\n  }\n  return target;\n}\n'''
addition_find = '''\nfunction findCanonicalActiveAmbiguousTarget(\n  reservation: ReservationFenceSnapshot,\n  input: ReconcileLateProviderSuccessE15_1Input\n): ReservationFenceGrant | null {\n  const canonical = reservation.accessGrants.filter((grant) =>\n    grant.status === AccessStatus.ACTIVE &&\n    sameInstant(grant.startsAt, reservation.checkIn) &&\n    sameInstant(grant.endsAt, reservation.checkOut)\n  );\n  if (canonical.length !== 1 || canonical[0].id !== input.grantId) {\n    return null;\n  }\n\n  const target = canonical[0];\n  if (\n    target.recoveryOperation !== GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS ||\n    target.recoveryAttemptCount !== input.recoveryAttemptCount ||\n    !sameInstant(target.updatedAt, input.updatedAt) ||\n    !sameInstant(target.startsAt, input.startsAt) ||\n    !sameInstant(target.endsAt, input.endsAt) ||\n    positiveTtlockLockId(target) !== input.ttlockLockId ||\n    Number(target.ttlockKeyboardPwdId) !== input.providerKeyboardPwdId ||\n    !target.secureAccessCode\n  ) {\n    return null;\n  }\n\n  for (const sibling of reservation.accessGrants) {\n    if (sibling.id === target.id) continue;\n    if (isBlockingSibling(sibling)) return null;\n  }\n  return target;\n}\n'''
insert_after(e151, anchor_find, addition_find, 'EXIT_A_E151_FIND_ANCHOR')
insert_point = 'export async function rearmAmbiguousGrantUnderReservationFenceE15_1(\n'
late_helper = '''export async function reconcileLateProviderSuccessUnderReservationFenceE15_1(\n  prisma: PrismaClient,\n  input: ReconcileLateProviderSuccessE15_1Input\n): Promise<boolean> {\n  const result = await withReservationFence(\n    prisma,\n    input.reservationId,\n    async (tx, reservation) => {\n      if (!lifecycleMatches(reservation, {\n        organizationId: input.organizationId,\n        propertyId: input.propertyId,\n        now: input.now,\n        releaseStatus: GuestAccessReleaseStatus.ELIGIBLE,\n      })) {\n        return false;\n      }\n\n      const target = findCanonicalActiveAmbiguousTarget(\n        reservation,\n        input\n      );\n      if (!target) return false;\n\n      const cleared = await tx.accessGrant.updateMany({\n        where: {\n          id: target.id,\n          reservationId: reservation.id,\n          status: AccessStatus.ACTIVE,\n          recoveryOperation: GUEST_ACCESS_PROVISION_OPERATION.AMBIGUOUS,\n          recoveryAttemptCount: input.recoveryAttemptCount,\n          updatedAt: input.updatedAt,\n          ttlockKeyboardPwdId: input.providerKeyboardPwdId,\n          startsAt: reservation.checkIn,\n          endsAt: reservation.checkOut,\n        },\n        data: {\n          recoveryOperation: null,\n          recoveryAttemptCount: 0,\n          recoveryLastAttemptAt: null,\n          recoveryNextAttemptAt: null,\n          recoveryExhaustedAt: null,\n          lastError: null,\n          ttlockPayload: input.payload,\n        },\n      });\n      if (cleared.count !== 1) return false;\n\n      const released = await tx.reservation.updateMany({\n        where: {\n          id: reservation.id,\n          propertyId: input.propertyId,\n          status: ReservationStatus.ACTIVE,\n          paymentState: PaymentState.PAID,\n          guestAccessReleaseStatus: GuestAccessReleaseStatus.ELIGIBLE,\n          checkIn: reservation.checkIn,\n          checkOut: reservation.checkOut,\n        },\n        data: {\n          guestAccessReleaseStatus: GuestAccessReleaseStatus.RELEASED,\n          guestAccessReleasedAt: input.now,\n          guestAccessReleaseLastError: null,\n        },\n      });\n      if (released.count !== 1) {\n        throw new Error(\n          "GUEST_ACCESS_EXIT_A_RESERVATION_RELEASE_CAS_LOST"\n        );\n      }\n      return true;\n    }\n  );\n  return result === true;\n}\n\n'''
replace_once(e151, insert_point, late_helper + insert_point, 'EXIT_A_E151_LATE_HELPER_ANCHOR')

# Extend E15.1 tests with the actual production late-success helper.
e151_test = 'src/e15/guest-access-reservation-reconciliation-fence.e15-1.test.ts'
replace_once(
    e151_test,
    '  adoptProviderCredentialUnderReservationFenceE15_1,\n  rearmAmbiguousGrantUnderReservationFenceE15_1,\n',
    '  adoptProviderCredentialUnderReservationFenceE15_1,\n  reconcileLateProviderSuccessUnderReservationFenceE15_1,\n  rearmAmbiguousGrantUnderReservationFenceE15_1,\n',
    'EXIT_A_E151_TEST_IMPORT_ANCHOR',
)
append_test = '''\n\ntest("Exit Closure A reconciles late provider success under the reservation fence", async () => {\n  const db = buildDb({\n    reservation: reservation({\n      accessGrants: [grant({\n        status: AccessStatus.ACTIVE,\n        ttlockKeyboardPwdId: 5001,\n        secureAccessCode: { id: "code1" },\n        ttlockPayload: marker("VERIFYING_PROVIDER_STATE"),\n      })],\n    }),\n  });\n\n  assert.equal(\n    await reconcileLateProviderSuccessUnderReservationFenceE15_1(\n      db.prisma,\n      {\n        grantId: "g1",\n        reservationId: "r1",\n        organizationId: "o1",\n        propertyId: "p1",\n        startsAt: checkIn,\n        endsAt: checkOut,\n        updatedAt,\n        recoveryAttemptCount: 2,\n        ttlockLockId: 101,\n        now,\n        providerKeyboardPwdId: 5001,\n        payload: marker("RECONCILED_PRESENT"),\n      }\n    ),\n    true\n  );\n  assert.ok(db.calls.indexOf("LOCK_RESERVATION") < db.calls.indexOf("LOCK_GRANTS"));\n  assert.ok(db.calls.indexOf("UPDATE_GRANT") < db.calls.indexOf("UPDATE_RESERVATION"));\n});\n\ntest("Exit Closure A refuses late success when provider id contradicts durable local evidence", async () => {\n  const db = buildDb({\n    reservation: reservation({\n      accessGrants: [grant({\n        status: AccessStatus.ACTIVE,\n        ttlockKeyboardPwdId: 5001,\n        secureAccessCode: { id: "code1" },\n      })],\n    }),\n  });\n\n  assert.equal(\n    await reconcileLateProviderSuccessUnderReservationFenceE15_1(\n      db.prisma,\n      {\n        grantId: "g1",\n        reservationId: "r1",\n        organizationId: "o1",\n        propertyId: "p1",\n        startsAt: checkIn,\n        endsAt: checkOut,\n        updatedAt,\n        recoveryAttemptCount: 2,\n        ttlockLockId: 101,\n        now,\n        providerKeyboardPwdId: 9999,\n        payload: marker("MANUAL_REVIEW_REQUIRED"),\n      }\n    ),\n    false\n  );\n  assert.equal(db.calls.includes("UPDATE_GRANT"), false);\n});\n'''
p = Path(e151_test)
text = p.read_text(encoding='utf-8')
if 'Exit Closure A reconciles late provider success under the reservation fence' in text:
    raise SystemExit('EXIT_A_E151_TEST_ALREADY_PATCHED')
p.write_text(text.rstrip() + append_test + '\n', encoding='utf-8')

print('EXIT_A_PATCH_PART1_OK')
