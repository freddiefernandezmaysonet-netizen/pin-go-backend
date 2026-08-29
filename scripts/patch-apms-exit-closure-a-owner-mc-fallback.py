from pathlib import Path

path = Path("src/services/guest-journey-access-owner-mission-control.service.ts")
text = path.read_text(encoding="utf-8")
old = '''  const markerStates =
    intent.reservation.accessGrants.map((grant) =>
      guestAccessE15MarkerStateFromPayload(
        grant.ttlockPayload
      )
    );
'''
new = '''  const markerStates =
    (Array.isArray(intent.reservation.accessGrants)
      ? intent.reservation.accessGrants
      : []
    ).map((grant) =>
      guestAccessE15MarkerStateFromPayload(
        grant.ttlockPayload
      )
    );
'''
if text.count(old) != 1:
    raise SystemExit(f"OWNER_MC_FALLBACK_ANCHOR:{text.count(old)}")
path.write_text(text.replace(old, new, 1), encoding="utf-8")
print("APMS_EXIT_CLOSURE_A_OWNER_MC_FALLBACK_APPLIED")
