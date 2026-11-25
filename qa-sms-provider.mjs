import twilio from "twilio";
import assert from "node:assert/strict";
import {appendFileSync} from "node:fs";
import {randomBytes} from "node:crypto";

twilio.RequestClient.prototype.request = async function(options) {
  assert.equal(options.method.toUpperCase(), "POST");
  assert.match(options.uri, /\/Messages\.json$/);
  assert.equal(options.data.StatusCallback,"https://qa.invalid/webhooks/delivery/twilio");
  const sid="SM"+randomBytes(16).toString("hex");
  appendFileSync("/tmp/qa-sms-calls.jsonl", JSON.stringify({sid,to:options.data.To})+"\n");
  return {statusCode:201,headers:{},body:JSON.stringify({sid,status:"queued",to:options.data.To})};
};
