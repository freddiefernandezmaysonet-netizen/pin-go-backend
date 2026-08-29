from pathlib import Path

path = Path("src/e15/guest-access-reservation-reconciliation-fence.e15-1.ts")
text = path.read_text(encoding="utf-8")
old = '''  if (
    !lifecycleMatches(reservation, {
      organizationId: input.organizationId,
      propertyId: input.propertyId,
      now: new Date(Math.min(input.endsAt.getTime() - 1, Date.now())),
      releaseStatus: GuestAccessReleaseStatus.ELIGIBLE,
    })
  ) {
    return null;
  }

'''
if text.count(old) != 1:
    raise SystemExit("E15_1_HELPER_CLEANUP_ANCHOR_MISMATCH")
text = text.replace(old, "", 1)
path.write_text(text, encoding="utf-8")
