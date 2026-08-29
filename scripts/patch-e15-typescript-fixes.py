from pathlib import Path

path = Path("src/e15/guest-access-ambiguity-reconciliation.e15.ts")
text = path.read_text(encoding="utf-8")

old = """        timeoutMs: input.config.providerTimeoutMs,\n        fetchImpl: input.fetchImpl,\n      });\n"""
new = """        timeoutMs: input.config.providerTimeoutMs,\n        ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),\n      });\n"""
if text.count(old) != 1:
    raise SystemExit(f"E15 fetch optional anchor count={text.count(old)}")
text = text.replace(old, new, 1)

old = """  for (const grant of grants) {\n    const organizationId = grant.reservation?.property.organizationId;\n    const ttlockLockId = Number(grant.lock.ttlockLockId);\n"""
new = """  for (const grant of grants) {\n    if (!grant.reservation) {\n      metrics.manualReview += 1;\n      continue;\n    }\n    const reservation = grant.reservation;\n    const organizationId = reservation.property.organizationId;\n    const ttlockLockId = Number(grant.lock.ttlockLockId);\n"""
if text.count(old) != 1:
    raise SystemExit(f"E15 nullable reservation anchor count={text.count(old)}")
text = text.replace(old, new, 1)
text = text.replace("grant.reservation.", "reservation.")

path.write_text(text, encoding="utf-8")
