// Run locally with --env-file=.env.prime.local. No credentials are printed.
import { readFileSync } from 'node:fs';
const target = new URL(process.env.PRIME_PILOT_URL || '');
if (target.protocol !== 'https:' || !target.hostname.endsWith('.up.railway.app')) throw new Error('EXPECTED_OWNED_RAILWAY_HTTPS_URL');
const privateConfig = JSON.parse(readFileSync('.env.prime-provision.json', 'utf8'));
const response = await fetch(new URL('/internal/provision', target), {
  method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${privateConfig.bootstrap}` },
  body: JSON.stringify({ apiKey: process.env.PRIME_OPENAI_API_KEY, invitation: privateConfig.invitation }),
});
console.log(JSON.stringify({ status: response.status, configured: response.ok }));
if (!response.ok) process.exitCode = 1;
