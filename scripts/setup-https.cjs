'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

function findOpenSSL(explicit) {
  const candidates = explicit ? [explicit] : [process.env.OPENSSL_BIN, 'openssl',
    ...[process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean)
      .map(dir => path.join(dir, 'Git', 'usr', 'bin', 'openssl.exe'))];
  for (const candidate of candidates.filter(Boolean)) {
    const result = spawnSync(candidate, ['version'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (!result.error && result.status === 0 && /^OpenSSL (?:1\.1\.1|[3-9]\.)/.test(result.stdout)) return candidate;
  }
  throw new Error('OpenSSL 1.1.1以降が必要です。Git for Windows付属のOpenSSL、またはOPENSSL_BINで指定した実行ファイルを利用できます。');
}

function getHosts(ips, dnsNames = []) {
  const detected = ips ?? Object.values(os.networkInterfaces()).flat().filter(address =>
    address.family === 'IPv4' && !address.internal && !address.address.startsWith('169.254.')).map(address => address.address);
  const ipAddresses = [...new Set(['127.0.0.1', '::1', ...detected])];
  const names = [...new Set(['localhost', os.hostname().toLowerCase(), ...dnsNames.map(name => name.toLowerCase())])];
  for (const ip of ipAddresses) if (!net.isIP(ip)) throw new Error('IPアドレスが不正です。');
  for (const name of names) {
    if (name.length > 253 || !name.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      throw new Error('DNS名が不正です。');
    }
  }
  return { ips: ipAddresses, dns: names };
}

function configureEnv(root, certFile, keyFile, caFile) {
  const file = path.join(root, '.env');
  let contents = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const newline = contents.includes('\r\n') ? '\r\n' : '\n';
  for (const [key, target] of [['HTTPS_CERT_FILE', certFile], ['HTTPS_KEY_FILE', keyFile], ['HTTPS_CA_CERT_FILE', caFile]]) {
    const value = path.relative(root, target).replace(/\\/g, '/');
    if (/[\r\n"']/.test(value)) throw new Error('証明書のパスに対応していない文字があります。');
    const pattern = new RegExp(`^[ \\t]*${key}[ \\t]*=[^\\r\\n]*`, 'gm');
    if (pattern.test(contents)) contents = contents.replace(pattern, () => `${key}="${value}"`);
    else contents += `${contents && !contents.endsWith('\n') ? newline : ''}${key}="${value}"${newline}`;
  }
  const staging = path.join(root, `.env.https-${crypto.randomBytes(8).toString('hex')}`);
  try {
    fs.writeFileSync(staging, contents, { mode: 0o600, flag: 'wx' });
    fs.renameSync(staging, file);
  } finally { if (fs.existsSync(staging)) fs.unlinkSync(staging); }
}

function setupHttps({ root = path.resolve(__dirname, '..'), outputDir, ips, dns = [], configure = false, openssl: explicit } = {}) {
  root = path.resolve(root);
  const dir = path.resolve(root, outputDir || 'certs');
  const hosts = getHosts(ips, dns);
  fs.mkdirSync(dir, { recursive: true });
  const files = Object.fromEntries(['rootCA.pem', 'rootCA-key.pem', 'rootCA.cer', 'lan-cert.pem', 'lan-key.pem']
    .map(name => [name, path.join(dir, name)]));
  const haveCA = fs.existsSync(files['rootCA.pem']);
  if (haveCA !== fs.existsSync(files['rootCA-key.pem'])) throw new Error('CA証明書と秘密鍵が揃っていません。既存のCAは上書きしません。');
  let ca;
  if (haveCA) {
    ca = new crypto.X509Certificate(fs.readFileSync(files['rootCA.pem']));
    if (!ca.ca || !ca.verify(ca.publicKey) || !ca.checkPrivateKey(crypto.createPrivateKey(fs.readFileSync(files['rootCA-key.pem'])))) {
      throw new Error('既存のCA証明書または秘密鍵が不正です。');
    }
    if (Date.parse(ca.validTo) < Date.now() + 2 * 86400000) throw new Error('CAの有効期限が近いため、新しいCAを別のフォルダーで準備して端末に登録し直してください。');
  }
  let reuseServer = false;
  if (ca && fs.existsSync(files['lan-cert.pem']) && fs.existsSync(files['lan-key.pem'])) {
    try {
      const cert = new crypto.X509Certificate(fs.readFileSync(files['lan-cert.pem']));
      reuseServer = !cert.ca && cert.verify(ca.publicKey)
        && Date.parse(cert.validTo) > Date.now() + 30 * 86400000
        && cert.checkPrivateKey(crypto.createPrivateKey(fs.readFileSync(files['lan-key.pem'])))
        && hosts.ips.every(ip => cert.checkIP(ip)) && hosts.dns.every(name => cert.checkHost(name));
    } catch { /* Regenerate the leaf with the existing CA; never silently replace a trusted root. */ }
  }
  if (!reuseServer) {
    const openssl = findOpenSSL(explicit);
    const stage = fs.mkdtempSync(path.join(dir, '.https-'));
    const staged = name => path.join(stage, name);
    const run = args => {
      const result = spawnSync(openssl, args, { encoding: 'utf8', windowsHide: true, timeout: 60000 });
      if (result.error || result.status !== 0) throw new Error('OpenSSLで証明書を作成できませんでした。実行環境と出力先を確認してください。');
    };
    try {
      const requestConfig = staged('request.cnf');
      fs.writeFileSync(requestConfig, '[req]\nprompt = no\ndistinguished_name = dn\n[dn]\nCN = Image Playground\n');
      if (!haveCA) {
        run(['req', '-x509', '-newkey', 'rsa:3072', '-nodes', '-sha256', '-days', '3650', '-config', requestConfig,
          '-subj', '/CN=Image Playground Local CA', '-keyout', staged('rootCA-key.pem'), '-out', staged('rootCA.pem'),
          '-addext', 'basicConstraints=critical,CA:TRUE,pathlen:0', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
          '-addext', 'subjectKeyIdentifier=hash']);
        ca = new crypto.X509Certificate(fs.readFileSync(staged('rootCA.pem')));
      }
      const extensions = staged('server.cnf');
      fs.writeFileSync(extensions, ['[server_cert]', 'basicConstraints=critical,CA:FALSE',
        'keyUsage=critical,digitalSignature,keyEncipherment', 'extendedKeyUsage=serverAuth',
        'subjectKeyIdentifier=hash', 'authorityKeyIdentifier=keyid,issuer',
        `subjectAltName=${[...hosts.dns.map(name => 'DNS:' + name), ...hosts.ips.map(ip => 'IP:' + ip)].join(',')}`, ''].join('\n'));
      run(['req', '-new', '-newkey', 'rsa:3072', '-nodes', '-sha256', '-config', requestConfig,
        '-keyout', staged('lan-key.pem'), '-out', staged('server.csr')]);
      const days = Math.min(365, Math.floor((Date.parse(ca.validTo) - Date.now()) / 86400000) - 1);
      run(['x509', '-req', '-in', staged('server.csr'), '-CA', haveCA ? files['rootCA.pem'] : staged('rootCA.pem'),
        '-CAkey', haveCA ? files['rootCA-key.pem'] : staged('rootCA-key.pem'),
        '-set_serial', '0x' + crypto.randomBytes(16).toString('hex'), '-days', String(days), '-sha256',
        '-extfile', extensions, '-extensions', 'server_cert', '-out', staged('lan-cert.pem')]);
      const leaf = new crypto.X509Certificate(fs.readFileSync(staged('lan-cert.pem')));
      if (!leaf.verify(ca.publicKey)) throw new Error('作成した証明書の署名を検証できませんでした。');
      // Publish only after generation succeeds; CA reuse makes IP changes independent of device trust.
      for (const name of [...(haveCA ? [] : ['rootCA.pem', 'rootCA-key.pem']), 'lan-cert.pem', 'lan-key.pem']) {
        fs.writeFileSync(files[name], fs.readFileSync(staged(name)), { mode: name.includes('key') ? 0o600 : 0o644 });
        if (name.includes('key')) fs.chmodSync(files[name], 0o600);
      }
    } finally {
      // Remove only the staging directory created immediately above, inside the selected certificate folder.
      if (path.dirname(path.resolve(stage)) !== dir || !path.basename(stage).startsWith('.https-')) throw new Error('Unexpected certificate cleanup path');
      fs.rmSync(stage, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
  fs.writeFileSync(files['rootCA.cer'], ca.raw);
  if (configure) configureEnv(root, files['lan-cert.pem'], files['lan-key.pem'], files['rootCA.pem']);
  return { certFile: files['lan-cert.pem'], keyFile: files['lan-key.pem'], caFile: files['rootCA.pem'],
    trustFile: files['rootCA.cer'], caFingerprint: ca.fingerprint256, hosts, reusedCA: haveCA, reusedServer: reuseServer, configured: configure };
}

if (require.main === module) {
  try {
    const options = { dns: [] };
    const args = process.argv.slice(2);
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === '--configure') options.configure = true;
      else if (arg === '--help') {
        console.log('node scripts/setup-https.cjs [--configure] [--ip 192.168.1.10] [--dns name.local] [--out certs] [--openssl path]');
        process.exit(0);
      } else if (['--ip', '--dns', '--out', '--openssl'].includes(arg) && args[index + 1] && !args[index + 1].startsWith('--')) {
        const value = args[++index];
        if (arg === '--ip') (options.ips ??= []).push(value);
        else if (arg === '--dns') options.dns.push(value);
        else options[arg === '--out' ? 'outputDir' : 'openssl'] = value;
      } else throw new Error('引数が不正です。--help で使い方を確認してください。');
    }
    const result = setupHttps(options);
    console.log(result.reusedServer ? '既存の証明書を再利用しました。' : '自己署名CAを使ったサーバー証明書を準備しました。');
    console.log('証明書: ' + result.certFile);
    console.log('各端末で信頼する公開証明書: ' + result.trustFile);
    console.log('CA SHA-256: ' + result.caFingerprint);
    console.log('接続先: ' + [...result.hosts.dns, ...result.hosts.ips].join(', '));
    if (result.configured) console.log('.envのHTTPS証明書・秘密鍵のパスを設定しました。サーバーの再起動後に有効になります。');
    console.log('端末でrootCA.cerを信頼してからHTTPSで開いてください。秘密鍵（*-key.pem）は共有しないでください。');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { setupHttps, findOpenSSL, getHosts };
