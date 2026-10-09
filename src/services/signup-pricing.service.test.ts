import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveHaasPrice, assertMonthlyPrice, haasPriceIds, haasMonthlyAmounts } from './signup-pricing.service.js';
test('all six packages map to distinct monthly prices and exact cents',()=>{
 const env:Record<string,string>={};for(const model of Object.keys(haasMonthlyAmounts))for(const term of [12,24])env[`STRIPE_PRICE_HAAS_${model.toUpperCase()}_${term}_MONTHLY`]=`price_${model}_${term}`;
 for(const [model,amounts] of Object.entries(haasMonthlyAmounts))for(const term of [12,24]){
  const result=resolveHaasPrice({plan:'haas',lock:model,termMonths:term,smartDevices:'none'},1,'monthly',env)!;
  assert.equal(result.priceId,`price_${model}_${term}`);assert.equal(result.amount,amounts[term as 12|24]);assert.equal(result.selection.termMonths,term);
 }
 assert.equal(haasPriceIds(env).length,6);
});
test('invalid package, term, quantity, annual billing and paused add-ons fail closed',()=>{
 for(const extra of [{lock:'invalid'},{termMonths:6},{termMonths:'12'},{plan:'platform'},{smartDevices:'one'}])assert.throws(()=>resolveHaasPrice({plan:'haas',lock:'pro',termMonths:12,...extra},1,'monthly'),/INVALID_HAAS_SELECTION/);
 assert.throws(()=>resolveHaasPrice({plan:'haas',lock:'pro',termMonths:12},2,'monthly'),/INVALID_HAAS_SELECTION/);
 assert.throws(()=>resolveHaasPrice({plan:'haas',lock:'pro',termMonths:12},1,'yearly'),/INVALID_HAAS_SELECTION/);
 assert.throws(()=>resolveHaasPrice({plan:'haas',lock:'pro',termMonths:12},1,'monthly',{}),/HAAS_PRICE_NOT_CONFIGURED/);
 assert.equal(resolveHaasPrice({plan:'haas',lock:'pro'},1,'monthly'),null);
});
test('Stripe price must match active USD monthly licensed amount; never accepts upfront annual billing',()=>{
 const good={active:true,currency:'usd',unit_amount:7499,type:'recurring',billing_scheme:'per_unit',recurring:{interval:'month',interval_count:1,usage_type:'licensed'}};
 assert.doesNotThrow(()=>assertMonthlyPrice(good,7499));
 for(const change of [{active:false},{currency:'eur'},{unit_amount:6499},{transform_quantity:{divide_by:2}},{recurring:{interval:'year',interval_count:1,usage_type:'licensed'}},{recurring:{interval:'month',interval_count:12,usage_type:'licensed'}}])assert.throws(()=>assertMonthlyPrice({...good,...change},7499),/SUBSCRIPTION_PRICE_MISMATCH/);
});
