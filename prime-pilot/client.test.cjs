const test = require('node:test');
const assert = require('node:assert/strict');
const { build } = require('esbuild');
const { JSDOM } = require('jsdom');
const path = require('node:path');
const criteria = { destination: 'Puerto Rico', checkIn: '2026-11-06', checkOut: '2026-11-09', adults: 2, children: 0, infants: 0, maxTotal: 500, currency: 'USD', nfc: false, preferences: [], unsupported: [] };
test('React UI navigates, translates, searches and signs out with isolated fixtures', async () => {
  const bundle = await build({ entryPoints: [path.join(__dirname, 'client/main.tsx')], bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic', loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"production"' } });
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://prime.test/', runScripts: 'outside-only' });
  let searches = 0; let logouts = 0;
  dom.window.fetch = async (url, options) => ({ ok: true, json: async () => {
    if (url.endsWith('/member')) return { name: 'Freddie' };
    if (url.endsWith('/session') && options.method === 'DELETE') { logouts++; return { ok: true }; }
    searches++; const body = JSON.parse(options.body); assert.equal(body.language, 'es'); assert.ok(body.message.includes('Puerto Rico'));
    return { criteria, clarification: null, missing: [], results: [], failed: 0, status: 'NO_MATCHES' };
  } });
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
    click('Buscar con Pin AI'); await wait(() => text().includes('Todavía no hay una coincidencia.'));
    assert.equal(searches, 1); assert.equal(dom.window.document.querySelector('input[type=date]').value, '2026-11-06');
    click('Cerrar sesión'); await wait(() => text().includes('Código de invitación')); assert.equal(logouts, 1);
  } finally { dom.window.close(); }
});
