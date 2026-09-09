import assert from "node:assert/strict";
import test from "node:test";
import { buildAirbnbMappingRequest, prepareAirbnbHostMappingPlan } from "./airbnb-host-self-service.mapping-plan.service.js";

// Complete literal JSON objects extracted from the supplied Airbnb guide.
// The channel example remains BookingCom with unequal IDs, as documented.
const CHANNEL = {
  "data": {
    "type": "channel",
    "id": "716305c4-561a-4561-a187-7f5b8aeb5920",
    "attributes": {
      "id": "96177287-c3b2-4d98-9eb7-5c1927795825",
      "title": "Booking.com - Main",
      "channel": "BookingCom",
      "currency": "USD",
      "is_active": true,
      "settings": {
        "derived_option": {}
      },
      "rate_plans": [
        {
          "id": "b217a47d-c282-4591-a873-7758f2883237",
          "rate_plan_id": "7e9409b4-160b-4412-941f-09c2c205b13b",
          "settings": {
            "derived_option": {}
          }
        }
      ],
      "properties": [
        "daec1c06-a9f6-4a25-88fa-cc4e9dbea436"
      ],
      "actions": [
        "load_future_reservations"
      ],
      "expected_removal_date": "2026-08-17",
      "inserted_at": "2026-08-12T10:12:04.740476",
      "updated_at": "2026-08-12T10:14:37.786888",
      "status": "active"
    },
    "relationships": {
      "group": {
        "data": {
          "id": "5b79c003-a0b0-45b5-8428-e006a26b6a82",
          "type": "group"
        }
      },
      "properties": {
        "data": [
          {
            "id": "daec1c06-a9f6-4a25-88fa-cc4e9dbea436",
            "type": "property"
          }
        ]
      },
      "known_mappings": {
        "data": [
          {
            "id": "d1a48009-fc52-4940-9f68-e7f609b73f01",
            "type": "known_mapping",
            "attributes": {
              "id": "d1a48009-fc52-4940-9f68-e7f609b73f01",
              "type": "auto",
              "rate_plan_code": "text",
              "room_type_code": "text",
              "rate_plan_id": "7e9409b4-160b-4412-941f-09c2c205b13b",
              "room_type_id": "06ededd7-16c1-40f7-97ee-b98bf8796fb9"
            }
          }
        ]
      }
    }
  }
};
const LISTINGS = {
  "data": {
    "listing_id_dictionary": {
      "values": [
        {
          "id": "42544559",
          "title": "Test Property · Test Channex Property",
          "type": "apartment",
          "occupancies": [
            1,
            2,
            3,
            4
          ],
          "synchronization_category": "text",
          "city": "text",
          "country_code": "DE",
          "quality_status": "text"
        }
      ]
    }
  }
};
const MAPPING = {
  "mapping": {
    "rate_plan_id": "7e9409b4-160b-4412-941f-09c2c205b13b",
    "settings": {
      "listing_id": "54843145465465419"
    }
  }
};

const CHANNEL_ID = CHANNEL.data.id;
const PROPERTY_ID = CHANNEL.data.attributes.properties[0]!;
const GROUP_ID = CHANNEL.data.relationships.group.data.id;
const PLAN_ID = MAPPING.mapping.rate_plan_id;
const LISTING_ID = LISTINGS.data.listing_id_dictionary.values[0]!.id;
const OTHER = "11111111-1111-4111-8111-111111111111";
function harness() {
  const calls: string[] = [];
  const queries: any[] = [];
  const row: any = {
    organizationId: "org-1", propertyId: "property-1", platform: "CHANNEX", provisioningStatus: "READY",
    externalPropertyId: PROPERTY_ID, externalPrimaryRoomTypeId: null, externalPrimaryRatePlanId: PLAN_ID,
    group: { organizationId: "org-1", platform: "CHANNEX", provisioningStatus: "READY", externalGroupId: GROUP_ID },
  };
  const channel: any = structuredClone(CHANNEL);
  const listings: any = structuredClone(LISTINGS);
  const args = {
    client: { distributionProperty: { async findFirst(query: unknown) { calls.push("property"); queries.push(query); return row; } } },
    transport: {
      async getChannel(id: string): Promise<unknown> { calls.push(`channel:${id}`); return channel; },
      async listListings(id: string): Promise<unknown> { calls.push(`listings:${id}`); return listings; },
    },
    organizationId: "org-1", propertyId: "property-1", channelId: CHANNEL_ID, listingId: LISTING_ID,
  };
  return { args, row, channel, listings, calls, queries };
}
test("pure builder equals the literal mapping body, without seeded defaults", () => {
  assert.deepEqual(buildAirbnbMappingRequest({ratePlanId: PLAN_ID, listingId: MAPPING.mapping.settings.listing_id}), MAPPING);
});
test("one scoped local snapshot, fresh exact channel and listing reads, execution always disabled", async () => {
  const h = harness(); const plan = await prepareAirbnbHostMappingPlan(h.args);
  assert.deepEqual(h.calls, ["property", `channel:${CHANNEL_ID}`, `listings:${CHANNEL_ID}`]);
  assert.equal(h.queries.length, 1);
  assert.deepEqual(h.queries[0].where, {organizationId:"org-1", propertyId:"property-1", platform:"CHANNEX"});
  assert.deepEqual(plan, { propertyId:"property-1",channelId:CHANNEL_ID,
    listing:{id:LISTING_ID,title:LISTINGS.data.listing_id_dictionary.values[0]!.title},
    ratePlan:{id:PLAN_ID,source:"PIN_GO_PRIMARY_RATE_PLAN"},
    mappingRequest:{mapping:{rate_plan_id:PLAN_ID,settings:{listing_id:LISTING_ID}}},
    executable:false,nextAction:"MAPPING_EXECUTION_REQUIRES_APPROVAL" });
  assert.deepEqual(h.channel, CHANNEL); assert.deepEqual(h.listings, LISTINGS);
});
test("proposed rate plan cannot come from a second changed property/group snapshot", async () => {
  const h=harness(); h.args.transport.getChannel=async id => {
    h.calls.push(`channel:${id}`); h.row.externalPrimaryRatePlanId=OTHER;
    h.row.externalPropertyId=OTHER; h.row.group.externalGroupId=OTHER;
    return h.channel;
  };
  assert.equal((await prepareAirbnbHostMappingPlan(h.args)).ratePlan.id, PLAN_ID);
  assert.equal(h.queries.length,1);
});
for (const [label, overrides] of [
  ["empty organization",{organizationId:""}], ["empty property",{propertyId:""}],
  ["invalid channel",{channelId:"../other"}], ["empty listing",{listingId:""}],
] as Array<[string,Record<string,string>]>) {
  test(`invalid local input fails before reads: ${label}`,async()=>{
    const h=harness(); await assert.rejects(()=>prepareAirbnbHostMappingPlan({...h.args,...overrides}));
    assert.deepEqual(h.calls,[]);
  });
}
for (const [label, mutate] of [
  ["wrong tenant",(h:any)=>{h.row.organizationId="other";}],
  ["wrong property",(h:any)=>{h.row.propertyId="other";}],
  ["not ready",(h:any)=>{h.row.provisioningStatus="PENDING";}],
  ["wrong platform",(h:any)=>{h.row.platform="OTHER";}],
  ["missing group",(h:any)=>{h.row.group=null;}],
  ["other group tenant",(h:any)=>{h.row.group.organizationId="other";}],
  ["group not ready",(h:any)=>{h.row.group.provisioningStatus="PENDING";}],
] as Array<[string,(h:any)=>void]>) {
  test(`local boundary rejection before provider access: ${label}`,async()=>{
    const h=harness();mutate(h);await assert.rejects(()=>prepareAirbnbHostMappingPlan(h.args));
    assert.deepEqual(h.calls,["property"]);
  });
}
for (const [label, mutate] of [
  ["channel substitution",(h:any)=>{h.channel.data.id=OTHER;}],
  ["property substitution",(h:any)=>{h.channel.data.attributes.properties=[OTHER];}],
  ["group substitution",(h:any)=>{h.channel.data.relationships.group.data.id=OTHER;}],
] as Array<[string,(h:any)=>void]>) {
  test(`channel boundary rejection before listings: ${label}`,async()=>{
    const h=harness();mutate(h);await assert.rejects(()=>prepareAirbnbHostMappingPlan(h.args));
    assert.deepEqual(h.calls,["property",`channel:${CHANNEL_ID}`]);
  });
}
for (const id of [null,"","not-a-uuid"]) {
  test(`invalid proposed primary plan: ${String(id)}`,async()=>{
    const h=harness();h.row.externalPrimaryRatePlanId=id;
    await assert.rejects(()=>prepareAirbnbHostMappingPlan(h.args),(e:any)=>e.code==="OTA_AIRBNB_MAPPING_RATE_PLAN_ID_INVALID");
  });
}
for (const values of [[],[{id:"other-listing",title:"Other"}]]) {
  test("selected listing must occur in the fresh response",async()=>{
    const h=harness();h.listings.data.listing_id_dictionary.values=values;
    await assert.rejects(()=>prepareAirbnbHostMappingPlan(h.args),(e:any)=>e.code==="OTA_AIRBNB_MAPPING_LISTING_NOT_FOUND");
  });
}
test("synthetic opaque listing identity and title remain exact",async()=>{
  const h=harness(); const id=" 00/x?&ñ ";const title="  Literal <title>  ";
  h.listings.data.listing_id_dictionary.values=[{id,title}];h.args.listingId=id;
  const plan=await prepareAirbnbHostMappingPlan(h.args);
  assert.deepEqual(plan.listing,{id,title});assert.equal(plan.mappingRequest.mapping.settings.listing_id,id);
});
for (const method of ["getChannel","listListings"] as const) {
  test(`upstream ${method} failure is not retried or replaced by fabricated evidence`,async()=>{
    const h=harness();const error=new Error("test-only upstream failure");
    h.args.transport[method]=async id=>{h.calls.push(`${method}:${id}`);throw error;};
    await assert.rejects(()=>prepareAirbnbHostMappingPlan(h.args),e=>e===error);
    assert.equal(h.calls.filter(c=>c.startsWith(method+":")).length,1);
  });
}
