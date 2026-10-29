import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const configRequire = createRequire(require.resolve("@prisma/config"));
const { deepmerge } = configRequire("deepmerge-ts");

test("Prisma config resolves the patched merger and safely handles recursive graphs", () => {
  const left: any = {}; left.self = left;
  const right: any = {}; right.self = right;
  try { deepmerge(left, right); }
  catch (error) {
    assert.ok(error instanceof Error);
    assert.notEqual(error.name, "RangeError", "recursive config must not exhaust the stack");
  }
  assert.deepEqual(deepmerge({ nested: { first: true } }, { nested: { second: true } }),
    { nested: { first: true, second: true } });
});
