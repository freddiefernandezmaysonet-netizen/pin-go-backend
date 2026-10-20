import assert from 'node:assert/strict';
import test from 'node:test';
import jwt from 'jsonwebtoken';
process.env.JWT_SECRET='synthetic-test-only-secret-never-used-in-production';
const {signSessionBoundAuthToken,verifySessionBoundAuthToken}=await import('./session-bound-token.js');
const {buildAuthCookie}=await import('../lib/auth.js');
const payload={sub:'host',orgId:'org',email:'host@example.invalid',role:'ORG_ADMIN',tokenVersion:1};
test('rolling session JWT pins policy and has enough lifetime for renewal',()=>{
 for(const [policy,days] of [['HOST_MOBILE_V1',31],['HOST_WEB_V1',2]] as const){
  const token=signSessionBoundAuthToken(payload,'sid',policy),decoded=jwt.decode(token) as jwt.JwtPayload;
  assert.equal(decoded.exp!-decoded.iat!,days*86400);
  assert.equal(verifySessionBoundAuthToken(token).sp,policy);
  assert.equal(verifySessionBoundAuthToken(token).sid,'sid');
  assert.match(buildAuthCookie(token,{maxAgeSeconds:days*86400}),new RegExp(`Max-Age=${days*86400}`));
 }
});
test('unbound legacy credentials do not acquire rolling claims',()=>{
 const decoded=jwt.decode(signSessionBoundAuthToken(payload,null,'HOST_MOBILE_V1')) as jwt.JwtPayload;
 assert.equal(decoded.sp,undefined);assert.equal(decoded.sid,undefined);
});
