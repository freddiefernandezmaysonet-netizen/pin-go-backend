import {appendFileSync} from "node:fs";
import {randomUUID} from "node:crypto";
globalThis.fetch = async (request, options) => {
  if (String(request) !== "https://api.resend.com/emails" || options?.method !== "POST") throw Error("Unexpected synthetic transport request");
  const email = JSON.parse(options.body);
  const id = randomUUID();
  appendFileSync("/tmp/qa-email-calls.jsonl", JSON.stringify({id,to:email.to})+"\n");
  return Response.json({id});
};
