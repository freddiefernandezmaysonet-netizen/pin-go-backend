import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServer, type IncomingMessage } from "node:http";
import { test } from "node:test";
import type { Socket } from "node:net";
import { SALES_VOICE_SIDEBAND_MAX_MESSAGE_BYTES } from "./sales-voice-protocol-limits.service.js";
import { salesVoiceStartupConfig } from "./sales-voice-live-admission.service.js";
import { withSalesVoicePricing } from "./sales-voice-pricing.service.js";
import { observeExistingLiveSession } from "./sales-voice-sideband-supervisor.service.js";
import { withSalesVoiceConversationDiagnostics } from "./sales-voice-conversation-diagnostics.service.js";
import {
  createOpenAISidebandWsFactory,
  SalesSidebandTransportError,
} from "./sales-voice-sideband-ws-transport.service.js";

const testUrl = "wss://api.openai.com/v1/live/sessions/live_fixture123/attach";
const auth = "Bearer sk-fixture12345";
const options = {
  headers: { Authorization: auth },
  handshakeTimeout: 5000,
  maxPayload: SALES_VOICE_SIDEBAND_MAX_MESSAGE_BYTES,
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
    maxPayload: SALES_VOICE_SIDEBAND_MAX_MESSAGE_BYTES,
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

test("actual commercial startup snapshot crosses the old 16 KiB limit without dropping the monitored call",async()=>{
  const WS=createRequire(import.meta.url)("ws");
  let session:any;
  await withSalesVoicePricing(async(_url,request)=>{
    session={...JSON.parse(request.body).session,id:"live_fixture123"};return{status:200};
  },{},async()=>null)("https://api.openai.com/v1/live/sessions/live_fixture123/accept",{
    method:"POST",headers:{},body:JSON.stringify(salesVoiceStartupConfig()),signal:new AbortController().signal,
  });
  const frame=JSON.stringify({type:"session.started",session});
  assert.ok(Buffer.byteLength(frame)>16*1024,"fixture must reproduce the previous message-size failure");
  assert.ok(Buffer.byteLength(frame)<SALES_VOICE_SIDEBAND_MAX_MESSAGE_BYTES);
  const server=createServer(),sockets=new WS.WebSocketServer({server,perMessageDeflate:false});
  sockets.on("connection",(peer:any)=>{
    peer.send(frame);
    peer.send(JSON.stringify({type:"session.output_transcript.delta",delta:"PRIVATE_GREETING"}));
  });
  await new Promise<void>(resolve=>server.listen(0,"127.0.0.1",resolve));
  const addr=server.address();assert.ok(addr&&typeof addr!=="string");
  const local="ws://127.0.0.1:"+addr.port;
  let client:any,connection:Awaited<ReturnType<typeof observeExistingLiveSession>>|undefined;
  const reports:any[]=[];
  class LoopbackSocket{
    constructor(_url:string,input:any){return client=new WS(local,input);}
  }
  try{
    connection=await observeExistingLiveSession({
      db:{salesVoiceCall:{findUnique:async()=>({provider:"OPENAI_LIVE_SIP",direction:"INBOUND",status:"ACCEPTED",finalizedAt:null})}} as any,
      sessionId:"live_fixture123",apiKey:"sk-fixture",enabled:true,
      connect:withSalesVoiceConversationDiagnostics(createOpenAISidebandWsFactory(LoopbackSocket as any),value=>reports.push(value)),
    });
    let settled=false;void connection.completion.then(()=>{settled=true;});
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(Error("STARTUP_FRAME_TIMEOUT")),1500);
      client.once("error",(error:Error)=>{clearTimeout(timer);reject(error);});
      client.on("message",(raw:Buffer)=>{
        if(JSON.parse(raw.toString()).type==="session.output_transcript.delta"){
          clearTimeout(timer);setImmediate(resolve);
        }
      });
    });
    assert.equal(client.readyState,WS.OPEN);assert.equal(settled,false);
    assert.equal(reports.at(-1).outputSeen,true);
    assert.ok(!JSON.stringify(reports).includes("PRIVATE_GREETING"));
    connection.disconnect();
    assert.equal((await connection.completion).state,"UNCONFIRMED_DISCONNECT");
  }finally{
    connection?.disconnect();client?.terminate();
    for(const peer of sockets.clients)peer.terminate();
    await new Promise<void>(resolve=>sockets.close(()=>resolve()));
    await new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()));
  }
});
