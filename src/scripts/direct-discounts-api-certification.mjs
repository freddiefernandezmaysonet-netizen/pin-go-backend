import assert from "node:assert/strict";
const base = "https://direct-discounts-certification-certification.up.railway.app";
const origin = "https://pin-go-dashboard-6xutdxi7i.vercel.app";
const path = "/api/dashboard/properties/cmwcizx320002mz1boxprmhz2/direct-discounts";
let cookie = "";
async function request(route, method = "GET", body, authenticated = true) {
 const response = await fetch(base + route, { method, signal: AbortSignal.timeout(15000), headers: { Origin: origin, "X-Pin-Go-Brand-Hostname":new URL(origin).hostname,
 ...(authenticated && cookie ? { Cookie: cookie } : {}), ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? {body:JSON.stringify(body)} : {}) });
 const data = await response.json().catch(() => null);
 return {status:response.status,data,cookie:response.headers.get("set-cookie")};
}
assert.equal((await request(path)).status,401);
assert.equal((await request("/auth/login","POST",{email:"discount-ui@example.com",password:"wrong-test-password"})).status,401);
const signed = await request("/auth/login","POST",{email:"discount-ui@example.com",password:process.env.CERT_TEST_PASSWORD});
assert.equal(signed.status,200); cookie = signed.cookie.split(";")[0]; assert.ok(cookie.startsWith("pingo_brand_token="));
assert.equal((await request("/auth/me")).status,200);
const initial = await request(path);assert.equal(initial.status,200);
let version = initial.data.version;
const rule=(id,type,threshold,percent)=>({id,type,threshold,percent,enabled:true,bookingFrom:null,bookingTo:null,stayFrom:null,stayTo:null,excludedDates:[]});
const config={...initial.data.config,enabled:true,combination:"STACK",maxDiscountPercent:100,minimumFinalNightlyRate:0,rules:[rule("early","EARLY_BIRD",30,10),rule("long","LENGTH_OF_STAY",7,5)]};
try {
 const saved=await request(path,"PUT",{config,version});assert.equal(saved.status,200);version=saved.data.version;
 assert.deepEqual((await request(path)).data.config,config);
 assert.equal((await request(path,"PUT",{config,version:version-1})).status,409);
 const quote=async(c)=>{const r=await request(path+"/preview","POST",{config:c,checkIn:"2030-01-02",checkOut:"2030-01-09"});assert.equal(r.status,200,JSON.stringify(r.data));return r.data.pricing;};
 const pricing=await quote(config);
 assert.equal(Number(pricing.accommodationDiscountTotal),101.5);
 assert.equal(Number(pricing.accommodationSubtotalAfterDiscount),598.5);
 assert.equal(Number(pricing.cleaningFee),75);assert.equal(Number(pricing.amenitiesTotal),25);assert.equal(Number(pricing.totalAmount),747.4);
 assert.equal(Number((await quote({...config,combination:"BEST"})).totalAmount),781.1);
 assert.equal(Number((await quote({...config,enabled:false})).totalAmount),856);
 assert.equal(Number((await quote({...config,maxDiscountPercent:12})).totalAmount),766.12);
 assert.equal(Number((await quote({...config,minimumFinalNightlyRate:90})).totalAmount),781.1);
 assert.equal(Number((await quote({...config,rules:config.rules.map(r=>({...r,excludedDates:["2030-01-03"]}))})).totalAmount),856);
 assert.equal((await request(path,"PUT",{config:{...config,maxDiscountPercent:101},version})).status,400);
 console.log(JSON.stringify({passed:true,checks:["unauthenticated denied","invalid password denied","real login and cookie","authenticated config","save and reload","stale version rejected","stack 747.40","best 781.10","disabled 856.00","cap 766.12","floor 781.10","excluded night 856.00","invalid config rejected"],productionChanged:false}));
} finally {
 const restored = await request(path,"PUT",{config:initial.data.config,version});assert.equal(restored.status,200);
 console.log("Original synthetic configuration restored");
}