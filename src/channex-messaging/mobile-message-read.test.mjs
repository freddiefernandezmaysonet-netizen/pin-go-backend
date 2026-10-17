import assert from 'node:assert/strict';
import test from 'node:test';
import {createMobileMessageReads, messageReadInput} from './mobile-message-read.ts';
const id = '11111111-1111-4111-8111-111111111111';
const scope = {organizationId: 'org', userId: 'host', propertyId: 'property', threadId: id};
test('read inputs reject supplied authority, timestamps, bulk marks and invalid pages', () => {
  assert.deepEqual(messageReadInput({messageId: id, page: 1}), {messageId: id, page: 1});
  for (const body of [null, [], {messageId: id, page: 0}, {messageId: id, page: 1, userId: 'other'},
    {messageId: id, page: 1, readAt: 'now'}, {messageId: 'bad', page: 1}, {messageId: id, page: 10001}])
    assert.throws(() => messageReadInput(body));
});
test('only an exact visible guest message can be marked; readback scopes receipts to the current Host', async () => {
  const writes = [], reads = [];
  const api = createMobileMessageReads({hostMobileMessageRead: {
    createMany: async value => {writes.push(value);},
    findMany: async value => {reads.push(value); return [{messageId: id}];},
  }});
  const guest = {id, sender: 'guest'}, property = {id: 'other', sender: 'property'};
  assert.deepEqual(await api.mark(scope, id, [guest]), {messageId: id, read: true});
  assert.deepEqual(writes[0], {data: [{...scope, messageId: id}], skipDuplicates: true});
  for (const items of [[], [{id, sender: 'property'}]]) await assert.rejects(api.mark(scope, id, items), /NOT_VISIBLE/);
  const result = await api.decorate(scope, [guest, property]);
  assert.equal(result[0].read, true); assert.equal(result[1].read, null);
  assert.deepEqual(reads[0].where, {...scope, messageId: {in: [id]}}); assert.equal(writes.length, 1);
});
