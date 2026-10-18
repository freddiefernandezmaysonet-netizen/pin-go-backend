import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {dirname,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import express from 'express';
import ts from 'typescript';
const root=fileURLToPath(new URL('../',import.meta.url));
const nativeRequire=createRequire(import.meta.url);
// Real HTTP routes and canonical trusted-device persistence/lookup; only OTP,
// password comparison, signing and database/network boundaries are synthetic.
test('mobile trust is issued after MFA, skips only subsequent MFA and retains web cookie rules',async t=>{
  const users=[{id:'host',email:'host@example.invalid',organizationId:'org',role:'ORG_ADMIN',isActive:true,tokenVersion:1,passwordHash:'synthetic',organization:null},
    {id:'other',email:'other@example.invalid',organizationId:'other-org',role:'ORG_ADMIN',isActive:true,tokenVersion:1,passwordHash:'synthetic',organization:null}];
  const devices:any[]=[],sessions:any[]=[],events:any[]=[],challenges=new Map<string,any>();let lookups=0;
  let hash:(token:string)=>string;
  const db:any={
    dashboardUser:{findUnique:async({where}:any)=>users.find(u=>where.email?u.email===where.email:u.id===where.id),update:async()=>({})},
    mfaChallenge:{findUnique:async({where}:any)=>[...challenges.values()].find(c=>hash(c.token)===where.challengeTokenHash)||null},
    trustedDevice:{create:async({data}:any)=>{const row={...data,id:`device-${devices.length}`,revokedAt:null};devices.push(row);return row;},
      findFirst:async({where}:any)=>{lookups++;return devices.find(d=>d.userId===where.userId&&d.tokenHash===where.tokenHash&&!d.revokedAt&&d.expiresAt>where.expiresAt.gt)||null;},update:async()=>({})},
    authSession:{create:async({data}:any)=>{const row={...data,id:`session-${sessions.length}`};sessions.push(row);return row;}},
    securityEvent:{create:async({data}:any)=>{events.push(data);return data;}}
  };
  const cache=new Map<string,any>();
  const noop=(_req:any,_res:any,next:any)=>next?.();
  function load(file:string):any{
    if(cache.has(file))return cache.get(file).exports;
    const module={exports:{}};cache.set(file,module);
    const require=(name:string):any=>{
      if(name==='express')return nativeRequire('express');
      if(name==='@prisma/client')return {PrismaClient:class{constructor(){return db;}}};
      if(name.startsWith('node:'))return nativeRequire(name);
      const target=resolve(dirname(file),name).replace(/\.js$/,'.ts');
      const stem=target.replace(/\.ts$/,'');
      if(stem.endsWith('/lib/auth'))return {comparePassword:async(p:string)=>p==='synthetic-password',buildAuthCookie:()=> 'auth=synthetic',buildClearAuthCookie:()=>'',extractTokenFromRequest:()=>null,hashPassword:async()=>''};
      if(stem.endsWith('/lib/passwordPolicy'))return {validatePasswordPolicy:()=>({ok:true})};
      if(stem.endsWith('/controllers/password.controller'))return {forgotPasswordHandler:noop,verifyForgotPasswordCodeHandler:noop,resetPasswordHandler:noop};
      if(stem.endsWith('/middleware/requireAuth'))return {requireAuth:noop};
      if(stem.endsWith('/auth/mfa-global-runtime'))return {evaluateE7EffectiveMode:()=>({mode:'ENFORCE',ready:true,failClosed:true}),requiresE7MfaChallenge:()=>true};
      if(stem.endsWith('/auth/mfa-login-runtime'))return {observeE5ShadowLogin:()=>{throw Error('Unexpected shadow');}};
      if(stem.endsWith('/auth/mfa-canary-flow'))return {beginE6EmailCanary:async(i:any,input:any)=>{const token=`challenge-${challenges.size}`;challenges.set(token,{token,userId:input.userId,used:false});return {challengeToken:token,maskedDestination:'h***@example.invalid',expiresAt:new Date(Date.now()+300000)};},resendE6EmailCanary:async()=>({ok:false,reason:'NOT_FOUND'})};
      if(stem.endsWith('/auth/mfa-login-challenge'))return {verifyLoginEmailMfaChallenge:async(_db:any,input:any)=>{const c=challenges.get(input.challengeToken);if(!c||c.used)return {ok:false,reason:'NOT_FOUND'};if(input.code!=='000000')return {ok:false,reason:'INVALID_CODE'};c.used=true;return {ok:true,userId:c.userId};}};
      if(stem.endsWith('/auth/mfa-email-otp-delivery'))return {resolveMfaEmailDeliveryMode:()=> 'RESEND'};
      if(stem.endsWith('/auth/session-bound-token'))return {signSessionBoundAuthToken:(_p:any,id:string)=>`synthetic-session-${id}`,verifySessionBoundAuthToken:()=>({})};
      if(stem.endsWith('/auth/session-binding-shadow'))return {revokeBoundSessionOnLogout:async()=>({})};
      if(stem.endsWith('/auth/session-enforcement-runtime'))return {touchBoundSessionHumanActivity:async()=>({})};
      return load(stem+'.ts');
    };
    const code=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    vm.runInNewContext(code,{module,exports:module.exports,require,console,process,Buffer,Date,URL,setTimeout,clearTimeout},{filename:file});return module.exports;
  }
  hash=load(resolve(root,'auth/mfa-core.ts')).hashOpaqueToken;
  const app=express();app.use(express.json());app.use(load(resolve(root,'routes/auth.routes.ts')).authRouter);
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(r=>server.once('listening',r));
  t.after(()=>new Promise<void>(r=>{server.close(r);server.closeAllConnections();}));
  async function post(path:string,body:any,headers:any={'x-pin-go-client':'mobile'}){const response=await fetch(`http://127.0.0.1:${(server.address() as any).port}${path}`,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});return {status:response.status,body:await response.json(),headers:response.headers};}
  const login=(email=users[0]!.email,token?:unknown,headers?:any,password='synthetic-password')=>post('/auth/login',{email,password,...(token?{mobileTrustedDeviceToken:token}:{})},headers);
  const first=await login();assert.equal(first.body.mfaRequired,true);assert.equal(devices.length,0);
  const bad=await post('/auth/mfa/verify',{challengeToken:first.body.challengeToken,code:'wrong',trustDevice:true});assert.equal(bad.status,401);assert.equal(devices.length,0);
  const accepted=await post('/auth/mfa/verify',{challengeToken:first.body.challengeToken,code:'000000',trustDevice:true});
  assert.equal(accepted.status,200);assert.equal(accepted.headers.get('cache-control'),'no-store');
  const token=accepted.body.mobileTrustedDeviceToken;assert.match(token,/^[A-Za-z0-9_-]{43}$/);assert.equal(devices.length,1);
  assert.ok(Math.abs(Date.parse(accepted.body.mobileTrustedDeviceExpiresAt)-Date.now()-30*86400000)<5000);
  assert.equal(devices[0].tokenHash,hash(token));assert.equal(devices[0].label,'Trusted mobile device');assert.ok(!JSON.stringify(events).includes(token));
  const next=await login(users[0]!.email,token);assert.equal(next.body.mfaRequired,undefined);assert.ok(next.body.mobileSessionToken);assert.equal(sessions.at(-1).trustedDeviceId,devices[0].id);
  const n=lookups;assert.equal((await login(users[0]!.email,token,undefined,'wrong')).status,401);assert.equal(lookups,n);
  assert.equal((await login(users[1]!.email,token)).body.mfaRequired,true);
  devices[0].revokedAt=new Date();assert.equal((await login(users[0]!.email,token)).body.mfaRequired,true);devices[0].revokedAt=null;
  const expiry=devices[0].expiresAt;devices[0].expiresAt=new Date(0);assert.equal((await login(users[0]!.email,token)).body.mfaRequired,true);devices[0].expiresAt=expiry;
  for(const headers of [{'x-pin-go-client':'mobile',origin:'https://app.pin-ngo.com'},{'x-pin-go-client':'mobile',cookie:`pingo_trusted_device=${token}`}])assert.equal((await login(users[0]!.email,token,headers)).body.mfaRequired,true);
  assert.equal((await login(users[0]!.email,token,{})).body.mfaRequired,true);
  assert.ok((await login(users[0]!.email,undefined,{cookie:`pingo_trusted_device=${token}`})).body.user);
  const web=await login(users[0]!.email,undefined,{});const webVerified=await post('/auth/mfa/verify',{challengeToken:web.body.challengeToken,code:'000000',trustDevice:true},{});
  assert.equal(webVerified.body.mobileTrustedDeviceToken,undefined);assert.equal(webVerified.body.mobileSessionToken,undefined);assert.ok(webVerified.headers.getSetCookie().some(v=>v.startsWith('pingo_trusted_device=')));
  const optout=await login(users[1]!.email);const out=await post('/auth/mfa/verify',{challengeToken:optout.body.challengeToken,code:'000000',trustDevice:false});assert.equal(out.body.mobileTrustedDeviceToken,undefined);assert.equal(devices.length,2);
});
