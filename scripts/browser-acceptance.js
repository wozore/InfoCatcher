'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const CONFIG = path.join(ROOT, 'config', 'browser.local.json');
const PORT = 4173;

function fail(message) { throw new Error(message); }
function readConfig() {
  if (!fs.existsSync(CONFIG)) fail(`BROWSER_CONFIG_MISSING:${CONFIG}`);
  const config = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
  if (!config.executablePath || !fs.existsSync(config.executablePath)) fail(`BROWSER_EXECUTABLE_MISSING:${config.executablePath || ''}`);
  return config;
}
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
async function waitHttp(url, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const response = await fetch(url); if (response.ok) return response; } catch {}
    await wait(100);
  }
  fail(`TIMEOUT:${url}`);
}
function cdp(wsUrl) {
  const socket = new WebSocket(wsUrl);
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
    }
  });
  const open = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  return { socket, open, command(method, params = {}) { const id = ++nextId; return open.then(() => new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); })); } };
}
async function evaluate(client, expression, returnByValue = true) {
  const result = await client.command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue });
  if (result.exceptionDetails) fail(`BROWSER_EVAL:${result.exceptionDetails.text || 'unknown error'}`);
  return result.result?.value;
}
async function assertBrowser(client, name, expression) {
  const value = await evaluate(client, expression);
  if (!value) fail(`ASSERTION_FAILED:${name}`);
  console.log(`  PASS ${name}`);
}
async function main() {
  const config = readConfig();
  if (!fs.existsSync(DIST)) fail(`DIST_MISSING:${DIST}`);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'infocatcher-edge-'));
  const server = spawn(process.platform === 'win32' ? 'python' : 'python3', ['-m', 'http.server', String(PORT), '--directory', DIST], { cwd: ROOT, stdio: 'ignore' });
  const browser = spawn(config.executablePath, [`--headless=new`, `--disable-gpu`, `--no-first-run`, `--no-default-browser-check`, `--remote-debugging-port=9222`, `--user-data-dir=${profile}`, `http://127.0.0.1:${PORT}/`], { stdio: 'ignore' });
  let client;
  try {
    await waitHttp(`http://127.0.0.1:${PORT}/`);
    const targets = await waitHttp('http://127.0.0.1:9222/json/list').then(response => response.json());
    const page = targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl);
    if (!page) fail('BROWSER_PAGE_TARGET_MISSING');
    client = cdp(page.webSocketDebuggerUrl);
    await client.command('Runtime.enable');
    await client.command('Page.enable');
    await wait(1200);
    const consoleErrors = [];
    client.socket.addEventListener('message', event => { const message = JSON.parse(String(event.data)); if (message.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(message.params.type)) consoleErrors.push(message.params.type); });
    await assertBrowser(client, '首页加载', `document.title.includes('InfoCatcher')`);
    await assertBrowser(client, '工具库导航', `(()=>{document.querySelector('[data-view="tools"]').click();return document.querySelector('#view-tools').classList.contains('active')})()`);
    await wait(300);
    await assertBrowser(client, '工具视图切换', `(()=>{const t=document.querySelector('#toolsViewToggle');if(t.getAttribute('aria-checked')!=='true')t.click();return t.getAttribute('aria-checked')==='true'})()`);
    await wait(300);
    await assertBrowser(client, '18 张模型卡逐一可搜索', `(()=>{const targets=['GLM-5.3','Kimi K3','Qwen3.8 Max','Muse Spark 1.2','Gemini 3.7 Flash','Gemini 3.6 Flash','Gemma 4','MiniMax M3','MiniMax M2.7','Grok 4.5','混元 Hy3','Step-3.5-Flash','Step-3.7-Flash','Nemotron 3 Ultra','Nemotron 3 Super','Nemotron 3.5','MiMo-V2.5','MiMo-V2.5 Pro'];const input=document.querySelector('#searchInput');const root=document.querySelector('#toolDirectoryView');return (async()=>{for(const target of targets){input.value=target;input.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,80));if(!root.innerText.includes(target))return false;}return true})()})()`);
    await assertBrowser(client, 'Qwen 详情可打开', `(()=>{const input=document.querySelector('#searchInput');input.value='Qwen3.8 Max';input.dispatchEvent(new Event('input',{bubbles:true}));const card=[...document.querySelectorAll('.tool-card')].find(x=>x.innerText.includes('Qwen3.8 Max'));if(!card)return false;card.click();return !document.querySelector('#modalOverlay').hidden})()`);
    await assertBrowser(client, '旧 Spark 与 xunfei 不出现', `!document.body.innerText.includes('Spark 4.0 Ultra')&&!document.body.innerText.includes('Spark Pro')&&!document.body.innerText.includes('Spark Lite')&&!document.body.innerText.includes('Spark X2')`);
    await assertBrowser(client, '对比页加载', `(()=>{document.querySelector('[data-view="compare"]').click();return document.querySelector('#view-compare').classList.contains('active')})()`);
    await wait(500);
    await evaluate(client, `(()=>{const input=document.querySelector('#cmpModelSearch');input.value='GLM-5.3';input.dispatchEvent(new Event('input',{bubbles:true}));return new Promise(resolve=>setTimeout(()=>resolve(true),500))})()`);
    await assertBrowser(client, '对比搜索 GLM-5.3', `document.querySelector('#cmpModelList').innerText.toLowerCase().includes('glm 5.3')`);
    await assertBrowser(client, '排除模型不在对比搜索', `(()=>{const input=document.querySelector('#cmpModelSearch');input.value='GPT-5.2';input.dispatchEvent(new Event('input',{bubbles:true}));return new Promise(resolve=>setTimeout(()=>resolve(!document.querySelector('#cmpModelList').innerText.includes('GPT-5.2')),400))})()`);
    if (consoleErrors.length) fail(`BROWSER_CONSOLE_ERRORS:${consoleErrors.join(',')}`);
    console.log('Browser acceptance passed.');
  } finally {
    client?.socket.close();
    browser.kill();
    server.kill();
    await wait(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (error) { console.warn(`TEMP_PROFILE_CLEANUP_WARNING:${error.code}`); }
  }
}
main().catch(error => { console.error(`Browser acceptance failed: ${error.message}`); process.exitCode = 1; });
