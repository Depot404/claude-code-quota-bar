// Test standalone du path CDP — utilise Runtime.evaluate dans une page claude.ai
// pour faire le fetch (utilise le TLS fingerprint de Brave, contourne Cloudflare).

import http from 'node:http';
import { WebSocket } from 'ws';

const CDP_HOST = '127.0.0.1';
const CDP_PORT = 9222;

function httpGetJson(url, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('CDP ping timeout')); });
  });
}

class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 0;
    this.pending = new Map();
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl, { perMessageDeflate: false });
      this.ws.on('open', () => resolve());
      this.ws.on('error', reject);
      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.id && this.pending.has(msg.id)) {
            const { res, rej } = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (msg.error) rej(new Error(msg.error.message || 'CDP error'));
            else res(msg.result);
          }
        } catch {}
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function main() {
  console.log('1. Get browser WS...');
  const version = await httpGetJson(`http://${CDP_HOST}:${CDP_PORT}/json/version`, 1500);
  const browser = new CdpClient(version.webSocketDebuggerUrl);
  await browser.connect();

  console.log('2. Create background tab on https://claude.ai/...');
  const { targetId } = await browser.send('Target.createTarget', {
    url: 'https://claude.ai/',
    background: true,
  });
  console.log(`   targetId: ${targetId}`);

  try {
    console.log('3. Attach to that target...');
    const { sessionId } = await browser.send('Target.attachToTarget', {
      targetId,
      flatten: true,
    });
    console.log(`   sessionId: ${sessionId}`);

    // Wait for navigation to complete and JS to settle
    console.log('4. Wait for page load (Cloudflare challenge passes if needed)...');
    await new Promise(r => setTimeout(r, 4000));

    // Send a Runtime.evaluate in that session
    console.log('5. Evaluate fetch(/api/organizations) inside the page...');
    const fetchScript = `
      (async () => {
        try {
          const r = await fetch('/api/organizations', { credentials: 'include', headers: { 'accept': 'application/json' } });
          const text = await r.text();
          return { ok: true, status: r.status, body: text };
        } catch (e) { return { ok: false, err: String(e) }; }
      })()
    `;
    const evalRes = await new Promise((resolve, reject) => {
      const id = ++browser.nextId;
      browser.pending.set(id, { res: resolve, rej: reject });
      browser.ws.send(JSON.stringify({
        id,
        sessionId,
        method: 'Runtime.evaluate',
        params: { expression: fetchScript, awaitPromise: true, returnByValue: true },
      }));
    });
    console.log(`   eval status: ${JSON.stringify(evalRes.result?.value).slice(0, 200)}`);

    if (evalRes.result?.value?.ok && evalRes.result.value.status === 200) {
      const orgs = JSON.parse(evalRes.result.value.body);
      const pick = orgs.find(o => !o.archived_at) || orgs[0];
      const orgId = pick?.uuid;
      console.log(`   orgId: ${orgId}`);

      console.log('6. Evaluate fetch(/api/organizations/{id}/usage)...');
      const usageScript = `
        (async () => {
          try {
            const r = await fetch('/api/organizations/${orgId}/usage', { credentials: 'include', headers: { 'accept': 'application/json' } });
            return { ok: true, status: r.status, body: await r.text() };
          } catch (e) { return { ok: false, err: String(e) }; }
        })()
      `;
      const u = await new Promise((resolve, reject) => {
        const id = ++browser.nextId;
        browser.pending.set(id, { res: resolve, rej: reject });
        browser.ws.send(JSON.stringify({
          id,
          sessionId,
          method: 'Runtime.evaluate',
          params: { expression: usageScript, awaitPromise: true, returnByValue: true },
        }));
      });
      console.log(`   usage status: ${u.result?.value?.status}`);
      if (u.result?.value?.status === 200) {
        const usage = JSON.parse(u.result.value.body);
        console.log(`   five_hour: ${usage.five_hour?.utilization}% reset=${usage.five_hour?.resets_at}`);
        console.log(`   seven_day: ${usage.seven_day?.utilization}% reset=${usage.seven_day?.resets_at}`);
        console.log('\nOK: CDP+Runtime.evaluate path validé.');
      } else {
        console.log(`   FAIL body: ${u.result?.value?.body?.slice(0, 200)}`);
      }
    } else {
      console.log(`   FAIL eval: ${JSON.stringify(evalRes).slice(0, 400)}`);
    }
  } finally {
    console.log('7. Cleanup: closing target...');
    try { await browser.send('Target.closeTarget', { targetId }); } catch (e) { console.log(`   close err: ${e.message}`); }
    browser.close();
  }
}

main().catch(e => { console.error('\nFATAL:', e.message); process.exit(1); });
