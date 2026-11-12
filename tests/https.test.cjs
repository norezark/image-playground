'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const https = require('node:https');
const crypto = require('node:crypto');
const { setupHttps, findOpenSSL, getHosts } = require('../scripts/setup-https.cjs');
const { createTestServer } = require('./helpers/test-server.cjs');

let openssl;
try { openssl = findOpenSSL(); } catch { /* Certificate creation is optional on hosts without OpenSSL. */ }

function tempProject(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'image-playground-https-'));
  t.after(() => {
    if (path.dirname(path.resolve(root)) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('image-playground-https-')) {
      throw new Error('Unexpected cleanup path');
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return root;
}

function request(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent: false, ...options }, response => {
      const chunks = [];
      response.on('data', data => { chunks.push(data); });
      response.on('end', () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status: response.statusCode, headers: response.headers, body: bytes.toString('utf8'), bytes });
      });
    });
    req.setTimeout(5000, () => req.destroy(new Error('HTTPS request timed out')));
    req.on('error', reject);
  });
}

test('self-signed CA setup preserves credentials, reuses valid certificates and renews LAN SANs without changing trust', { skip: !openssl }, t => {
  const root = tempProject(t);
  const initial = '# settings\r\nOPENAI_API_KEY=test-only-value\r\nHTTPS_CERT_FILE=old.pem\r\nHTTPS_KEY_FILE=old-key.pem\r\nWEB_PUSH_SUBJECT=mailto:owner@example.com\r\n';
  fs.writeFileSync(path.join(root, '.env'), initial);
  const certs = setupHttps({ root, outputDir: 'my certificates', ips: ['192.168.1.10'], configure: true, openssl });
  const ca = new crypto.X509Certificate(fs.readFileSync(certs.caFile));
  const server = new crypto.X509Certificate(fs.readFileSync(certs.certFile));
  assert.equal(ca.ca, true);
  assert.equal(ca.subject, ca.issuer);
  assert.equal(ca.verify(ca.publicKey), true);
  assert.equal(server.ca, false);
  assert.equal(server.verify(ca.publicKey), true);
  assert.equal(server.checkPrivateKey(crypto.createPrivateKey(fs.readFileSync(certs.keyFile))), true);
  assert.equal(server.checkIP('192.168.1.10'), '192.168.1.10');
  assert.equal(server.checkIP('127.0.0.1'), '127.0.0.1');
  assert.equal(server.checkHost('localhost'), 'localhost');
  assert.equal(server.checkIP('192.0.2.55'), undefined);
  assert.deepEqual(new crypto.X509Certificate(fs.readFileSync(certs.trustFile)).raw, ca.raw);
  const configured = fs.readFileSync(path.join(root, '.env'), 'utf8');
  assert.equal(configured, initial.replace('HTTPS_CERT_FILE=old.pem', 'HTTPS_CERT_FILE="my certificates/lan-cert.pem"')
    .replace('HTTPS_KEY_FILE=old-key.pem', 'HTTPS_KEY_FILE="my certificates/lan-key.pem"')
    + 'HTTPS_CA_CERT_FILE="my certificates/rootCA.pem"\r\n');
  const again = setupHttps({ root, outputDir: 'my certificates', ips: ['192.168.1.10'], configure: true, openssl });
  assert.equal(again.reusedCA, true);
  assert.equal(again.reusedServer, true);
  assert.deepEqual(fs.readFileSync(again.certFile), Buffer.from(server.toString()));
  assert.equal(fs.readFileSync(path.join(root, '.env'), 'utf8'), configured);
  const changed = setupHttps({ root, outputDir: 'my certificates', ips: ['192.168.1.11'], openssl });
  assert.equal(changed.reusedCA, true);
  assert.equal(changed.reusedServer, false);
  const changedServer = new crypto.X509Certificate(fs.readFileSync(changed.certFile));
  assert.equal(changedServer.checkIP('192.168.1.11'), '192.168.1.11');
  assert.equal(changedServer.verify(ca.publicKey), true);
  assert.equal(new crypto.X509Certificate(fs.readFileSync(changed.caFile)).fingerprint256, ca.fingerprint256);
  assert.equal(fs.readdirSync(path.dirname(changed.certFile)).some(name => name.startsWith('.https-')), false);
});

test('arbitrary PEM paths serve the app and push configuration over HTTPS with CA and hostname verification enabled', { skip: !openssl }, async t => {
  const root = tempProject(t);
  const certs = setupHttps({ root, ips: ['192.168.1.10'], openssl });
  const certFile = path.join(root, 'external certificate.pem'), keyFile = path.join(root, 'external private key.pem');
  fs.copyFileSync(certs.certFile, certFile);
  fs.copyFileSync(certs.keyFile, keyFile);
  // Even an accidentally combined PEM bundle must only serve the public X.509 certificate.
  const caBundle = path.join(root, 'CA bundle.pem');
  fs.writeFileSync(caBundle, fs.readFileSync(certs.caFile, 'utf8') + fs.readFileSync(path.join(root, 'certs/rootCA-key.pem'), 'utf8'));
  const app = await createTestServer({ tls: { certFile, keyFile, caFile: caBundle } });
  t.after(app.close);
  assert.match(app.url, /^https:/);
  const ca = fs.readFileSync(certs.caFile);
  const page = await request(app.url, { ca });
  assert.equal(page.status, 200);
  assert.match(page.body, /pushToggle/);
  const config = await request(app.url + '/push/config', { ca });
  assert.match(JSON.parse(config.body).publicKey, /^[\w-]{87}$/);
  assert.equal((await request(app.url + '/sw.js', { ca })).status, 200);
  assert.equal((await request(app.url.replace('localhost', '127.0.0.1') + '/push/config', { ca })).status, 200);
  assert.match(app.certificateUrl, /^http:\/\/localhost:\d+\/cert\/rootCA\.cer$/);
  const download = await fetch(app.certificateUrl);
  const bytes = Buffer.from(await download.arrayBuffer());
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/x-x509-ca-cert');
  assert.equal(download.headers.get('content-disposition'), 'attachment; filename="rootCA.cer"');
  assert.equal(download.headers.get('cache-control'), 'no-store');
  assert.equal(Number(download.headers.get('content-length')), bytes.length);
  assert.deepEqual(bytes, new crypto.X509Certificate(ca).raw);
  assert.equal(bytes.includes(Buffer.from('PRIVATE KEY')), false);
  const head = await fetch(app.certificateUrl, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  assert.equal(head.headers.get('content-length'), String(bytes.length));
  assert.equal((await fetch(app.certificateUrl, { method: 'POST' })).status, 405);
  for (const pathname of ['/history', '/generate', '/cert/rootCA-key.pem', '/certs/rootCA-key.pem', '/.env']) {
    assert.equal((await fetch(new URL(pathname, app.certificateUrl))).status, 404);
  }
  assert.deepEqual((await request(app.url + '/cert/rootCA.cer', { ca })).bytes, bytes);
  await assert.rejects(request(app.url), error => ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(error.code));
  await assert.rejects(request(app.url, { ca, servername: 'unlisted.example' }), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' });
});

test('certificate download also works in HTTP-only mode and fails closed for missing or private-key files', async t => {
  const app = await createTestServer();
  t.after(app.close);
  const url = app.url + '/cert/rootCA.cer';
  assert.equal((await fetch(url)).status, 404);
  const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  fs.writeFileSync(path.join(app.root, 'missing-ca.pem'), privateKey.export({ format: 'pem', type: 'pkcs8' }));
  const response = await fetch(url);
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes('PRIVATE KEY'), false);
});

test('certificate setup rejects malformed SANs and never overwrites an incomplete CA', t => {
  assert.throws(() => getHosts(['192.168.1.10\nDNS:attacker.example']), /IP/);
  assert.throws(() => getHosts([], ['example.com,IP:127.0.0.1']), /DNS/);
  const root = tempProject(t);
  const dir = path.join(root, 'certs');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'rootCA.pem'), 'incomplete CA');
  assert.throws(() => setupHttps({ root, ips: [] }), /揃っていません/);
  assert.equal(fs.readFileSync(path.join(dir, 'rootCA.pem'), 'utf8'), 'incomplete CA');
});
