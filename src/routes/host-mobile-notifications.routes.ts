import {Router,type Request,type RequestHandler} from 'express';
import type {PrismaClient} from '@prisma/client';
import {requireAuth,type AuthenticatedUser} from '../middleware/requireAuth.js';
import {authorizeMobileReply} from '../channex-messaging/mobile-reply-authorization.js';
import {verifySessionBoundAuthToken} from '../auth/session-bound-token.js';
import {guardAuthenticatedSession} from '../auth/session-request-guard.js';
import {createReviewRateLimit,reviewActorClientKey} from '../services/reviews/review-route-security.js';
import {createHostPushRegistry,HostPushRegistryError,type PushActor} from '../services/host-mobile-notification.registry.js';
import {createHostNotificationInbox} from '../services/host-mobile-notification-inbox.js';
export function buildHostMobileNotificationsRouter(input:{prisma:PrismaClient;env:Readonly<Record<string,string|undefined>>}){
  const router=Router(),root='/api/host-mobile/notifications',registry=createHostPushRegistry(input.prisma,input.env),inbox=createHostNotificationInbox(input.prisma);
  const enabled:RequestHandler=(_req,res,next)=>{res.setHeader('Cache-Control','no-store');if(input.env.HOST_MOBILE_PUSH_REGISTRATION_ENABLED!=='true'){res.status(503).json({ok:false,error:'HOST_PUSH_REGISTRATION_DISABLED'});return;}next();};
  const native:RequestHandler=async(req,res,next)=>{
    try{await authorizeMobileReply({enabled:true,authorization:req.get('authorization'),origin:req.get('origin'),cookie:req.get('cookie'),identity:(req as Request&{user?:AuthenticatedUser}).user},{verify:verifySessionBoundAuthToken,guard:args=>guardAuthenticatedSession(input.prisma as any,args)});next();}
    catch(error:any){res.status(typeof error?.status==='number'?error.status:503).json({ok:false,error:typeof error?.code==='string'?error.code:'SESSION_VALIDATION_UNAVAILABLE'});}
  };
  const actor=(req:Request):PushActor=>{const u=(req as Request&{user:AuthenticatedUser}).user;return{id:u.id,orgId:u.orgId,sessionId:u.sessionId!};};
  const wrap=(fn:(req:Request)=>Promise<unknown>):RequestHandler=>async(req,res)=>{try{res.json({ok:true,...await fn(req) as object});}catch(error){res.status(error instanceof HostPushRegistryError?error.status:503).json({ok:false,error:error instanceof HostPushRegistryError?error.code:'HOST_PUSH_REGISTRY_UNAVAILABLE'});}};
  router.use(root,enabled,requireAuth,native,createReviewRateLimit({namespace:'host-push-registry',max:30,windowMs:60000,key:reviewActorClientKey}));
  router.post(`${root}/devices`,wrap(req=>registry.register(actor(req),req.body)));
  router.post(`${root}/devices/status`,wrap(req=>registry.deviceStatus(actor(req),req.body)));
  router.delete(`${root}/devices/session`,wrap(req=>registry.revokeSession(actor(req))));
  router.get(`${root}/preferences`,wrap(async req=>({preference:await registry.preference(actor(req))})));
  router.put(`${root}/preferences`,wrap(req=>registry.savePreference(actor(req),req.body)));
  router.get(`${root}/inbox`,wrap(req=>inbox.list(actor(req),req.query)));
  router.post(`${root}/inbox/read`,wrap(req=>inbox.markRead(actor(req),req.body)));
  return router;
}


