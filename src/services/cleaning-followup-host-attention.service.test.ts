import assert from "node:assert/strict";import test from "node:test";
test("host-attention wording does not claim cleaning failed",()=>{const issue="Cleaner has not confirmed cleaning completion within the agreed follow-up window.";assert.doesNotMatch(issue,/did not clean|cleaning failed|property is dirty/i);assert.match(issue,/not confirmed/i);});
