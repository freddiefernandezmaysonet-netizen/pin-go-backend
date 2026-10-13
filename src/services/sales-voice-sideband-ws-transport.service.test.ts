import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer, type IncomingMessage } from "node:http";
import { test } from "node:test";
import type { Socket } from "node:net";
import {
  createOpenAISidebandWsFactory,
  SalesSidebandTransportError,
} from "./sales-voice-sideband-ws-transport.service.js";

const testUrl = "wss://api.openai.com/v1/live/sessions/live_fixture123/attach";
const auth = "Bearer sk-fixture12345";
const options = {
  headers: { Authorization: auth },
  handshakeTimeout: 5000,
  maxPayload: 16 * 1024,
  perMessageDeflate: false as const,
};

const err = (code: string) => (e: unknown) =>
  e instanceof SalesSidebandTransportError && e.code === code;

test("exact official Live sideband origin, pinned options and Bearer header only", () => {
  const attempts: Array<{url: string, options: Record<string, unknown>}> = [];
  class CaptureSocket {
    constructor(url: string, input: Record<string, unknown>) {
      attempts.push({url, options: input});
    }
    on() { return undefined; }
    close() {}
  }
  const open = createOpenAISidebandWsFactory(CaptureSocket as any);
  const connection = open(testUrl, options);
  assert.ok(connection);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].url, testUrl);
  assert.deepEqual(attempts[0].options, {
    headers: { Authorization: auth },
    handshakeTimeout: 5000,
    maxPayload: 16 * 1024,
    perMessageDeflate: false,
    followRedirects: false,
    rejectUnauthorized: true,
    maxRedirects: 0,
    protocolVersion: 13,
  });
});

test("URL allowlist blocks arbitrary servers, hidden credentials, redirects and query injection", () => {
  let attempts = 0;
  class Capture {
    constructor() { attempts++; }
    on() {}
    close() {}
  }
  const open = createOpenAISidebandWsFactory(Capture as any);
  const attacks = [
    "ws://api.openai.com/v1/live/sessions/live_fixture123/attach",
    "wss://example.com/v1/live/sessions/live_fixture123/attach",
    "wss://api.openai.com.evil.test/v1/live/sessions/live_fixture123/attach",
    "wss://api.openai.com/v1/live/sessions/live_fixture123/attach?key=x",
    "wss://user:pass@api.openai.com/v1/live/sessions/live_fixture123/attach",
    "wss://api.openai.com:8443/v1/live/sessions/live_fixture123/attach",
    "wss://api.openai.com/v1/realtime?call_id=rtc_123",
    "wss://api.openai.com/v1/live/sessions/live_fixture123/hangup",
    "wss://api.openai.com/v1/live/sessions/live_invalid%2Fother/attach",
    "wss://api.openai.com/v1/live/sessions/live_fixture123/attach#ignore",
  ];
  for (const attack of attacks) {
    assert.throws(() => open(attack,options), err("INVALID_PROVIDER_ENDPOINT"), attack);
  }
  assert.equal(attempts,0);
});

test("invalid token and weakened connection settings fail before WebSocket creation", () => {
  let attempts=0;
  class Capture {
    constructor() { attempts++; }
    on() {}
    close() {}
  }
  const open=createOpenAISidebandWsFactory(Capture as any);
  for (const token of ["Bearer hidden", "Basic abc", "Bearer sk-", "Bearer sk-abc\nHeader: x"]) {
    assert.throws(() => open(testUrl,{...options,headers:{Authorization:token}}),
      err("INVALID_PROVIDER_AUTHORIZATION"));
  }
  assert.throws(() => open(testUrl,{...options,perMessageDeflate:true as any}),
    err("UNSAFE_WEBSOCKET_SETTINGS"));
  assert.throws(() => open(testUrl,{...options,maxPayload:1024}),
    err("UNSAFE_WEBSOCKET_SETTINGS"));
  assert.throws(() => open(testUrl,{...options,handshakeTimeout:30000}),
    err("UNSAFE_WEBSOCKET_SETTINGS"));
  assert.equal(attempts,0);
});

test("pinned ws package performs real local HTTP upgrade and passes Authorization header", async () => {
  // A loopback fixture exercises the actual npm ws implementation WITHOUT
  // contacting OpenAI, Twilio, Railway or a public network.
  const require=createRequire(import.meta.url);
  const WS=require("ws");
  const server=createServer();
  const sockets=new WS.WebSocketServer({noServer:true,perMessageDeflate:false,maxPayload:16384});
  let authorization: string | undefined;
  let requested: string | undefined;
  server.on("upgrade",(req:IncomingMessage,sock:Socket,head:Buffer)=>{
    authorization=req.headers.authorization;
    requested=req.url;
    sockets.handleUpgrade(req,sock,head,(client:any)=>{
      sockets.emit("connection",client,req);
    });
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const addr=server.address();
  assert.ok(addr&&typeof addr!=="string");
  let client: any;
  try {
    const url="ws://127.0.0.1:"+addr.port+"/local-fixture";
    client=new WS(url,{
      headers:{Authorization:auth},
      handshakeTimeout:5000,
      maxPayload:16384,
      perMessageDeflate:false,
      followRedirects:false,
      maxRedirects:0,
      protocolVersion:13,
    });
    await new Promise<void>((resolve,reject)=>{
      client.once("open",resolve);
      client.once("error",reject);
    });
    assert.equal(authorization,auth);
    assert.equal(requested,"/local-fixture");
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error("LOOPBACK_ECHO_TIMEOUT")),1500);
      client.once("message",(data:Buffer)=>{
        clearTimeout(timer);
        try { assert.equal(data.toString("utf8"),"local-ok");resolve(); }
        catch(e){reject(e);}
      });
      for (const socket of sockets.clients) {
        socket.send("local-ok");
      }
    });
  } finally {
    try {client?.terminate();}catch{}
    for(const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve=>sockets.close(()=>resolve()));
    await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  }
});

test("no transport is created during import and no connection is initiated automatically", () => {
  assert.equal(typeof createOpenAISidebandWsFactory,"function");
  const factory=createOpenAISidebandWsFactory();
  assert.equal(typeof factory,"function");
  // No invocation -> no WebSocket, no network and no provider API charge.
});
