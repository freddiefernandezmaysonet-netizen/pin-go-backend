const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('esbuild');
const { JSDOM } = require('jsdom');
const path = require('node:path');
const criteria = { destination: 'Puerto Rico', checkIn: '2026-11-06', checkOut: '2026-11-09', adults: 2, children: 0, infants: 0, maxTotal: 500, currency: 'USD', nfc: false, minBedrooms: 2, minFullBathrooms: 1, preferences: [], unsupported: [] };
test('React UI holds a conversation, sends context, edits details, resets and signs out', async () => {
  const bundle = await build({ entryPoints: [path.join(__dirname, 'client/main.tsx')], bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } });
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://prime.test/', runScripts: 'outside-only' });
  let searches = 0; let logouts = 0;
  dom.window.fetch = async (url, options) => ({ ok: true, json: async () => {
    if (url.endsWith('/member')) return { name: 'Freddie' };
    if (url.endsWith('/session') && options.method === 'DELETE') { logouts++; return { ok: true }; }
    searches++; const body = JSON.parse(options.body); assert.equal(body.language, 'es');
    if (searches === 1) { assert.ok(body.message.includes('Puerto Rico')); assert.deepEqual(body.history, []); }
    else { assert.equal(body.message, 'Somos dos'); assert.equal(body.history.length, 2); assert.equal(body.history[1].role, 'assistant'); assert.equal(body.criteria.destination, 'Puerto Rico'); }
    const results = searches === 2 ? [{ property: { id: 'demo-fixture', name: 'Estancia de prueba', location: 'PR', photos: [], maxGuests: 4, features: ['pool', 'wifi', 'ocean_view'], nfcVerified: true, minimumAge: null, details: { source: 'HOST_LISTING', accommodationType: 'ENTIRE_PLACE', propertyType: 'APARTMENT', bedrooms: 2, fullBathrooms: 1, halfBathrooms: 2, beds: [{ type: 'QUEEN', quantity: 2 }], poolPrivacy: 'SHARED', sharedSpaces: ['POOL'], parkingFeeType: 'UNKNOWN', hostReportedNearbyPlaces: [{ name: 'Example beach', nameEs: 'Playa de ejemplo', category: 'BEACH', distanceText: '1 km', travelTimeMinutes: 5, travelMode: 'UNSPECIFIED', independentlyVerified: false }] } }, quote: { currency: 'USD', nights: 3, nightlySubtotal: 90, cleaningFee: 0, amenitiesTotal: 0, taxesTotal: 10, totalAmount: 100 }, checkedAt: '2026-10-27T12:00:00Z' }] : [];
    return { criteria, clarification: null, missing: [], results, failed: 0, status: searches === 2 ? 'RESULTS' : 'NO_MATCHES', reply: searches === 1 ? '¿Cuántos adultos viajarían?' : 'Entendido, preparo el viaje para dos.', replyFallback: false };
  } });
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  dom.window.AbortSignal.timeout = () => new dom.window.AbortController().signal;
  const wait = async (fn) => { for (let n = 0; n < 100; n++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('UI state timeout'); };
  const text = () => dom.window.document.body.textContent;
  const click = (label) => { const b = [...dom.window.document.querySelectorAll('button')].find(x => x.textContent === label || x.getAttribute('aria-label') === label); assert.ok(b, label); b.click(); };
  try {
    dom.window.eval(bundle.outputFiles[0].text);
    await wait(() => text().includes('Tu próxima estancia'));
    click('Mi tarjeta Prime'); await wait(() => text().includes('Prueba NFC superada'));
    click('Mis viajes'); await wait(() => text().includes('Tu próxima historia empieza aquí.'));
    click('English'); await wait(() => text().includes('Your next story starts here.'));
    click('Español'); await wait(() => text().includes('Mis viajes'));
    click('Explorar'); await wait(() => text().includes('Una escapada a Puerto Rico'));
    click('Una escapada a Puerto Rico'); await wait(() => dom.window.document.querySelector('textarea').value.includes('Puerto Rico'));
    assert.equal(dom.window.document.querySelector('input[type=date]'), null);
    click('Enviar a Pin AI'); await wait(() => text().includes('¿Cuántos adultos viajarían?'));
    assert.equal(searches, 1);
    const input = dom.window.document.querySelector('textarea');
    Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, 'value').set.call(input, 'Somos dos');
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    await wait(() => ![...dom.window.document.querySelectorAll('button')].find(x => x.getAttribute('aria-label') === 'Enviar a Pin AI').disabled);
    click('Enviar a Pin AI'); await wait(() => text().includes('Entendido, preparo el viaje para dos.'));
    assert.equal(searches, 2); assert.equal(dom.window.document.querySelectorAll('.prime-turn-user').length, 2);
    assert.ok(text().includes('¿Cuántos adultos viajarían?'));
    click('Ver estancia'); await wait(() => dom.window.document.querySelector('dialog').open);
    assert.ok(text().includes('La piscina es un espacio compartido.'));
    assert.ok(text().includes('medio de transporte sin especificar'));
    assert.ok(text().includes('Playa de ejemplo'));
    assert.ok(text().includes('2 Queen'));
    click('Seguir explorando'); await wait(() => !dom.window.document.querySelector('dialog').open);
    click('Ver y editar detalles'); await wait(() => dom.window.document.querySelector('input[type=date]'));
    assert.equal(dom.window.document.querySelector('input[type=date]').value, '2026-11-06');
    const bedroomLabel = [...dom.window.document.querySelectorAll('label')].find(x => x.textContent === 'Habitaciones mínimas');
    assert.equal(bedroomLabel.querySelector('input').value, '2');
    click('Nuevo viaje'); await wait(() => !text().includes('Entendido, preparo el viaje para dos.'));
    assert.equal(dom.window.document.querySelectorAll('.prime-turn-user').length, 0);
    assert.equal(dom.window.document.querySelector('input[type=date]'), null);
    click('Cerrar sesión'); await wait(() => text().includes('Código de invitación')); assert.equal(logouts, 1);
  } finally { dom.window.close(); }
});
