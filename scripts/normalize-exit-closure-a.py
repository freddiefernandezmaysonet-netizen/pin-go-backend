from pathlib import Path

paths = [
    Path("src/e15/guest-access-reservation-reconciliation-fence.e15-1.test.ts"),
]

for path in paths:
    text = path.read_text(encoding="utf-8")
    path.write_text(text.rstrip() + "\n", encoding="utf-8")

print("EXIT_A_FORMAT_NORMALIZED")
