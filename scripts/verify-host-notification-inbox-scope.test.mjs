import assert from 'node:assert/strict';
import test from 'node:test';
import {ALLOWED,BASE,INDEX,INDEX_ANCHOR,MODEL,SQL,verifyInboxScope,inspectCandidate} from './verify-host-notification-inbox-scope.mjs';
const repo='freddiefernandezmaysonet-netizen/pin-go-backend';
const candidate='a'.repeat(40);
const before='model SalesVoiceCall {\n  id String @id\n}\n\nmodel HostMobilePushDelivery {\n  id String @id\n'+INDEX_ANCHOR+'}\n';
const event=()=>({number:475,pull_request:{head:{sha:candidate,ref:'agent/host-notification-inbox-20261018',repo:{full_name:repo}},base:{sha:BASE,ref:'main',repo:{full_name:repo}}}});
const fixture=()=>({event:event(),paths:[...ALLOWED],before,after:before.replace(INDEX_ANCHOR,INDEX_ANCHOR+INDEX)+'\n'+MODEL,migration:SQL});
test('reviewed additive model/index/SQL passes without changing any prior schema',()=>{verifyInboxScope(fixture());});
test('other PRs, forks, branches and new bases do not get the inbox scope',()=>{
  for(const change of [x=>x.event.number++,x=>x.event.pull_request.head.repo.full_name='fork/repo',x=>x.event.pull_request.base.repo.full_name='fork/repo',
    x=>x.event.pull_request.head.ref='other',x=>x.event.pull_request.base.ref='other',x=>x.event.pull_request.base.sha='b'.repeat(40)]){
    const x=fixture();change(x);assert.throws(()=>verifyInboxScope(x));
  }
});
test('extra, missing, renamed and duplicate files fail; commercial runtime cannot piggyback',()=>{
  for(const paths of [[...ALLOWED,'src/services/sales-voice-runtime-boot.service.ts'],ALLOWED.slice(1),[...ALLOWED,'src/distribution/transport.ts'],[...ALLOWED,ALLOWED[0]]])
    assert.throws(()=>verifyInboxScope({...fixture(),paths}));
});
test('any existing schema edit or unreviewed model/index fails',()=>{
  for(const change of [s=>s.replace('model SalesVoiceCall','model ChangedCall'),s=>s.replace('  id String @id','  id String @id @default(cuid())'),
    s=>s.replace(MODEL,MODEL+MODEL),s=>s.replace(INDEX,''),s=>s.replace(INDEX,INDEX+INDEX),s=>INDEX+s.replace(INDEX,''),s=>s+'\nmodel Extra {\n id String @id\n}\n'])
    assert.throws(()=>verifyInboxScope({...fixture(),after:change(fixture().after)}));
});
test('destructive SQL, extra statements and altered migration targets fail',()=>{
  for(const migration of [SQL+'\nDROP TABLE "SalesVoiceCall";',SQL.replace('CREATE TABLE','ALTER TABLE'),SQL.replace('"eventId" TEXT','"eventId" INTEGER')])
    assert.throws(()=>verifyInboxScope({...fixture(),migration}));
});
test('candidate inspection binds the tested tree and schema and runs frozen-path/patch checks',()=>{
  const calls=[],x=fixture();
  const git=(...args)=>{
    calls.push(args);
    if(args[0]==='merge-base')return BASE+'\n';
    if(args[0]==='show')return args[1]===BASE+':prisma/schema.prisma'?before:args[1].endsWith('schema.prisma')?x.after:SQL;
    if(args.includes('--name-only'))return ALLOWED.join('\n');
    return '';
  };
  inspectCandidate(git,x.event,x.after);
  assert.ok(calls.some(c=>c[0]==='diff'&&c[1]==='--exit-code'&&c[2]===candidate&&c[3]==='HEAD'));
  assert.ok(calls.some(c=>c.includes(':(glob)src/services/sales-voice-*')));
  assert.equal(calls.filter(c=>c.includes('--check')).length,2);
  assert.throws(()=>inspectCandidate(git,x.event,x.after+'\n// changed checkout'));
  assert.throws(()=>inspectCandidate((...args)=>args[0]==='merge-base'?'b'.repeat(40):git(...args),x.event,x.after));
  assert.throws(()=>inspectCandidate((...args)=>{if(args[0]==='diff'&&args[2]===candidate)throw Error('different checkout tree');return git(...args);},x.event,x.after));
});
