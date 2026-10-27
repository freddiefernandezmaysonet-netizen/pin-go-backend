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
    if (url.endsWith('/saved-trips')) return { trips: [] };
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
    assert.equal(text().includes('Anfitrión · Demo'), false); // No founder tools without the capability.
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

test('founder enrollment UI saves explicit drafts, distinguishes saved status and requires reload on conflict', async () => {
  const bundle = await build({ entryPoints: [path.join(__dirname, 'client/main.tsx')], bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } });
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://prime.test/', runScripts: 'outside-only' });
  let enrollment = { version: 1, propertyId: 'cmomyua8b0001rv1dvl6xjr6g', revision: 0, participation: 'ACTIVE', benefitDraft: { nightlyDiscountPercent: 0, earlyCheckInRequest: false, lateCheckoutRequest: false, personalNfc: false }, benefitsDraftOnly: true, updatedAt: null, updatedBy: null };
  let writes = 0;
  dom.window.AbortSignal.timeout = () => new dom.window.AbortController().signal;
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
  dom.window.fetch = async (url, options) => {
    if (url.endsWith('/member')) return { ok: true, json: async () => ({ name: 'Freddie', capabilities: ['PILOT_HOST_SETUP'] }) };
    assert.ok(url.endsWith('/pilot/enrollment'));
    if (options.method === 'PUT') {
      const input = JSON.parse(options.body); assert.equal(input.confirmPilotOnly, true);
      assert.deepEqual(Object.keys(input).sort(), ['benefitDraft', 'confirmPilotOnly', 'expectedRevision', 'participation']);
      if (input.expectedRevision !== enrollment.revision) return { ok: false, status: 409, json: async () => ({ error: 'ENROLLMENT_CHANGED' }) };
      writes++; enrollment = { ...enrollment, participation: input.participation, benefitDraft: input.benefitDraft, revision: enrollment.revision + 1, updatedBy: 'prime-pilot-founder', updatedAt: '2026-10-27T12:00:00Z' };
    }
    return { ok: true, json: async () => ({ enrollment: JSON.parse(JSON.stringify(enrollment)) }) };
  };
  const wait = async fn => { for (let n = 0; n < 100; n++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('host UI timeout'); };
  const text = () => dom.window.document.body.textContent;
  const button = label => [...dom.window.document.querySelectorAll('button')].find(b => b.textContent === label);
  const check = label => { const element = [...dom.window.document.querySelectorAll('label')].find(l => l.textContent.includes(label)); assert.ok(element, label); element.querySelector('input').click(); };
  const select = value => { const element = dom.window.document.getElementById('prime-participation'); element.value = value; element.dispatchEvent(new dom.window.Event('change', { bubbles: true })); };
  try {
    dom.window.eval(bundle.outputFiles[0].text); await wait(() => button('Anfitrión · Demo'));
    button('Anfitrión · Demo').click(); await wait(() => dom.window.document.getElementById('prime-discount-draft'));
    assert.ok(text().includes('Activa en el buscador piloto')); assert.ok(button('Guardar configuración de Demo').disabled);
    select('PAUSED');
    const discount = dom.window.document.getElementById('prime-discount-draft');
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set.call(discount, '10'); discount.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    check('Solicitud de entrada temprana');
    assert.ok(text().includes('Activa en el buscador piloto')); // Pending edits do not claim already saved.
    check('Entiendo que estoy configurando'); await wait(() => !button('Guardar configuración de Demo').disabled);
    button('Guardar configuración de Demo').click(); await wait(() => text().includes('Configuración guardada.'));
    assert.equal(writes, 1); assert.equal(enrollment.participation, 'PAUSED'); assert.equal(enrollment.benefitDraft.nightlyDiscountPercent, 10); assert.equal(enrollment.benefitDraft.earlyCheckInRequest, true);
    assert.ok(text().includes('Pausada en el buscador piloto')); assert.ok(button('Guardar configuración de Demo').disabled);
    enrollment = { ...enrollment, revision: 2, participation: 'ACTIVE', benefitDraft: { ...enrollment.benefitDraft, nightlyDiscountPercent: 30 } };
    select('ACTIVE'); check('Entiendo que estoy configurando'); await wait(() => !button('Guardar configuración de Demo').disabled);
    button('Guardar configuración de Demo').click(); await wait(() => text().includes('La configuración cambió'));
    assert.equal(writes, 1); assert.ok(button('Guardar configuración de Demo').disabled);
    button('Recargar configuración').click(); await wait(() => dom.window.document.getElementById('prime-discount-draft')?.value === '30');
    assert.ok(text().includes('Activa en el buscador piloto')); assert.ok(button('Guardar configuración de Demo').disabled);
    button('English').click(); await wait(() => text().includes('Proposed benefits'));
    assert.ok(text().includes('Draft'));
  } finally { dom.window.close(); }
});

test('saved-trip UI survives a fresh page, resumes with fresh search, updates and removes a plan', async () => {
  const bundle = await build({ entryPoints: [path.join(__dirname, 'client/main.tsx')], bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } });
  const plannedCriteria = { ...criteria, preferences: ['private_pool'], unsupported: ['cerca de la playa'] };
  let saved = []; let searches = 0; let updates = 0; let dom;
  const wait = async fn => { for (let n = 0; n < 100; n++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw new Error('saved-trip UI timeout'); };
  const text = () => dom.window.document.body.textContent;
  const click = label => { const button = [...dom.window.document.querySelectorAll('button')].find(b => b.textContent === label || b.getAttribute('aria-label') === label); assert.ok(button, label); button.click(); };
  const value = (input, text) => { const prototype = input.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(prototype, 'value').set.call(input, text); input.dispatchEvent(new dom.window.Event('input', { bubbles: true })); };
  const open = async () => {
    dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://prime.test/', runScripts: 'outside-only' });
    dom.window.AbortSignal.timeout = () => new dom.window.AbortController().signal;
    dom.window.HTMLDialogElement.prototype.close = function () { this.open = false; };
    dom.window.fetch = async (url, options) => ({ ok: true, json: async () => {
      if (url.endsWith('/member')) return { name: 'Freddie' };
      if (url.includes('/saved-trips')) {
        if (options.method === 'GET') return { trips: JSON.parse(JSON.stringify(saved)) };
        if (options.method === 'DELETE') { saved = []; return { ok: true }; }
        const body = JSON.parse(options.body); assert.deepEqual(Object.keys(body).sort(), ['criteria', 'title']);
        if (options.method === 'PUT') { updates++; assert.ok(url.endsWith(saved[0].id)); }
        const trip = { ...body, id: '4f9093ad-c2cd-45a7-8bbb-b51233b22a6a', status: 'PLANNING', createdAt: '2026-10-27T12:00:00Z', updatedAt: '2026-10-27T12:00:00Z' };
        saved = [trip]; return { trip };
      }
      assert.ok(url.endsWith('/search')); searches++;
      const body = JSON.parse(options.body);
      if (searches > 1) { assert.deepEqual(body.criteria, plannedCriteria); assert.equal(body.message, undefined); assert.deepEqual(body.history, []); }
      return { criteria: plannedCriteria, clarification: null, missing: [], results: [], failed: 0, status: 'NO_MATCHES', reply: searches === 1 ? 'Mantengo tus requisitos de piscina y playa.' : 'Opciones consultadas de nuevo para tu viaje.', replyFallback: false };
    } });
    dom.window.eval(bundle.outputFiles[0].text);
    await wait(() => text().includes('Tu próxima estancia'));
  };
  try {
    await open(); value(dom.window.document.querySelector('textarea'), 'Quiero piscina privada cerca de la playa.');
    await wait(() => !dom.window.document.querySelector('button[aria-label="Enviar a Pin AI"]').disabled);
    click('Enviar a Pin AI'); await wait(() => text().includes('Mantengo tus requisitos'));
    click('Guardar viaje'); await wait(() => dom.window.document.getElementById('prime-plan-title'));
    value(dom.window.document.getElementById('prime-plan-title'), 'Escapada de playa');
    await wait(() => dom.window.document.getElementById('prime-plan-title').value === 'Escapada de playa');
    click('Guardar en Mis viajes'); await wait(() => text().includes('Guardado en Mis viajes.'));
    assert.deepEqual(saved[0].criteria, plannedCriteria); assert.equal(searches, 1);
    dom.window.close(); await open(); // Fresh React state; only the API record survives.
    click('Mis viajes'); await wait(() => text().includes('Escapada de playa'));
    assert.ok(text().includes('Sin reservación ni precio retenido')); assert.ok(text().includes('cerca de la playa'));
    click('Retomar viaje'); await wait(() => text().includes('Opciones consultadas de nuevo'));
    assert.equal(searches, 2); assert.equal(dom.window.document.querySelectorAll('.prime-turn-user').length, 1);
    click('Guardar cambios del viaje'); await wait(() => dom.window.document.getElementById('prime-plan-title'));
    value(dom.window.document.getElementById('prime-plan-title'), 'Viaje actualizado');
    await wait(() => dom.window.document.getElementById('prime-plan-title').value === 'Viaje actualizado');
    click('Guardar en Mis viajes'); await wait(() => updates === 1 && text().includes('Guardado en Mis viajes.'));
    assert.equal(saved.length, 1); assert.equal(saved[0].title, 'Viaje actualizado');
    click('Mis viajes'); await wait(() => text().includes('Viaje actualizado'));
    click('Eliminar plan Viaje actualizado'); await wait(() => text().includes('Confirmar eliminación'));
    click('Cancelar'); await wait(() => !text().includes('Confirmar eliminación')); assert.equal(saved.length, 1);
    click('Eliminar plan Viaje actualizado'); await wait(() => text().includes('Confirmar eliminación'));
    click('Confirmar eliminación'); await wait(() => text().includes('Tu próxima historia empieza aquí.'));
    assert.equal(saved.length, 0); assert.equal(searches, 2);
  } finally { dom?.window.close(); }
});
