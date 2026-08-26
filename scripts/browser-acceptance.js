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
  const serverCode = "import http.server, os; os.chdir('dist'); Handler=type('Handler',(http.server.SimpleHTTPRequestHandler,),{'extensions_map':{**http.server.SimpleHTTPRequestHandler.extensions_map,'.mjs':'text/javascript'}}); http.server.ThreadingHTTPServer((''," + PORT + "),Handler).serve_forever()";
  const server = spawn(process.platform === 'win32' ? 'python' : 'python3', ['-c', serverCode], { cwd: ROOT, stdio: 'ignore' });
  const browser = spawn(config.executablePath, [`--headless=new`, `--disable-gpu`, `--no-first-run`, `--no-default-browser-check`, `--remote-debugging-port=9222`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let client;
  try {
    await waitHttp(`http://127.0.0.1:${PORT}/`);
    const targets = await waitHttp('http://127.0.0.1:9222/json/list').then(response => response.json());
    const page = targets.find(target => target.type === 'page' && target.webSocketDebuggerUrl);
    if (!page) fail('BROWSER_PAGE_TARGET_MISSING');
    client = cdp(page.webSocketDebuggerUrl);
    await client.command('Runtime.enable');
    await client.command('Page.enable');
    const consoleErrors = [];
    client.socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      if (message.method === 'Runtime.consoleAPICalled' && ['error', 'assert'].includes(message.params.type)) consoleErrors.push(message.params.type);
    });
    await client.command('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
    const readyEnd = Date.now() + 15000;
    while (Date.now() < readyEnd && !(await evaluate(client, `document.querySelector('#app')?.getAttribute('aria-busy') === 'false'`))) await wait(100);
    await assertBrowser(client, '页面数据加载', `document.querySelector('#app')?.getAttribute('aria-busy') === 'false'`);
    await assertBrowser(client, '首页加载', `document.title.includes('InfoCatcher')`);
    await assertBrowser(client, '工具库导航', `(()=>{document.querySelector('[data-view="tools"]').click();return document.querySelector('#view-tools').classList.contains('active')})()`);
    await wait(300);
    await assertBrowser(client, '工具视图切换', `(()=>{const t=document.querySelector('#toolsViewToggle');if(t.getAttribute('aria-checked')!=='true')t.click();return t.getAttribute('aria-checked')==='true'})()`);
    await wait(300);
    await assertBrowser(client, '18 张模型卡逐一可搜索', `(()=>{const targets=['GLM-5.3','Kimi K3','Qwen3.8 Max','Muse Spark 1.2','Gemini 3.7 Flash','Gemini 3.6 Flash','Gemma 4','MiniMax M3','MiniMax M2.7','Grok 4.5','混元 Hy3','Step-3.5-Flash','Step-3.7-Flash','Nemotron 3 Ultra','Nemotron 3 Super','Nemotron 3.5','MiMo-V2.5','MiMo-V2.5 Pro'];const input=document.querySelector('#searchInput');const root=document.querySelector('#toolDirectoryView');return (async()=>{for(const target of targets){input.value=target;input.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,80));if(!root.innerText.includes(target))return false;}return true})()})()`);
    await assertBrowser(client, 'Gemini CLI 显示最近更新', `(()=>{const input=document.querySelector('#searchInput');input.value='Gemini CLI';input.dispatchEvent(new Event('input',{bubbles:true}));const name=[...document.querySelectorAll('.tool-card-name')].find(x=>x.textContent.trim().endsWith('Gemini CLI'));const card=name?.closest('.tool-card');if(!card)return false;card.click();const valid=document.querySelector('#modalContent').innerText.includes('最近更新 2026-08-19');window.closeModal();return valid})()`);
    await assertBrowser(client, 'Gemini 2.5 Pro 显示发布日期', `(()=>{const input=document.querySelector('#searchInput');input.value='Gemini 2.5 Pro';input.dispatchEvent(new Event('input',{bubbles:true}));const name=[...document.querySelectorAll('.tool-card-name')].find(x=>x.textContent.trim().endsWith('Gemini 2.5 Pro'));const card=name?.closest('.tool-card');if(!card)return false;card.click();const valid=document.querySelector('#modalContent').innerText.includes('发布日期 2025-06-17');window.closeModal();return valid})()`);
    await assertBrowser(client, 'Qwen 详情可打开', `(()=>{const input=document.querySelector('#searchInput');input.value='Qwen3.8 Max';input.dispatchEvent(new Event('input',{bubbles:true}));const card=[...document.querySelectorAll('.tool-card')].find(x=>x.innerText.includes('Qwen3.8 Max'));if(!card)return false;card.click();return !document.querySelector('#modalOverlay').hidden})()`);
    await assertBrowser(client, '旧 Spark 与 xunfei 不出现', `!document.body.innerText.includes('Spark 4.0 Ultra')&&!document.body.innerText.includes('Spark Pro')&&!document.body.innerText.includes('Spark Lite')&&!document.body.innerText.includes('Spark X2')`);
    await assertBrowser(client, '对比页加载', `(()=>{document.querySelector('[data-view="compare"]').click();return document.querySelector('#view-compare').classList.contains('active')})()`);
    await wait(500);
    await evaluate(client, `(()=>{const input=document.querySelector('#cmpModelSearch');input.value='GLM-5.3';input.dispatchEvent(new Event('input',{bubbles:true}));return new Promise(resolve=>setTimeout(()=>resolve(true),500))})()`);
    await assertBrowser(client, '对比搜索 GLM-5.3', `document.querySelector('#cmpModelList').innerText.toLowerCase().includes('glm 5.3')`);
    await assertBrowser(client, '搜索自动展开厂商与系列', `(()=>{const model=[...document.querySelectorAll('[data-cmp-pick]')].find(item=>item.textContent.toLowerCase().replace(/-/g,' ').includes('glm 5.3'));const series=model?.closest('[data-cmp-series]');const vendor=series?.closest('[data-cmp-vendor]');return !!model&&series?.querySelector('[data-cmp-series-toggle]')?.getAttribute('aria-expanded')==='true'&&vendor?.querySelector('[data-cmp-vendor-toggle]')?.getAttribute('aria-expanded')==='true'})()`);
    await assertBrowser(client, '对比厂商与具体模型图标加载', `(()=>{const model=[...document.querySelectorAll('[data-cmp-pick]')].find(item=>item.textContent.toLowerCase().replace(/-/g,' ').includes('glm 5.3'));const vendor=model?.closest('[data-cmp-vendor]');return vendor?.getAttribute('data-cmp-vendor')==='zai'&&!!vendor.querySelector('[data-cmp-vendor-toggle] .brand-icon')&&!!model.querySelector('.brand-icon')})()`);
    await assertBrowser(client, '厂商与系列可独立折叠', `(()=>{const model=[...document.querySelectorAll('[data-cmp-pick]')].find(item=>item.textContent.toLowerCase().replace(/-/g,' ').includes('glm 5.3'));const series=model?.closest('[data-cmp-series]');const vendor=series?.closest('[data-cmp-vendor]');if(!series||!vendor)return false;const vendorKey=vendor.getAttribute('data-cmp-vendor');const seriesKey=series.getAttribute('data-cmp-series');const findVendor=()=>[...document.querySelectorAll('[data-cmp-vendor]')].find(item=>item.getAttribute('data-cmp-vendor')===vendorKey);const findSeries=()=>[...document.querySelectorAll('[data-cmp-series]')].find(item=>item.getAttribute('data-cmp-series')===seriesKey);vendor.querySelector('[data-cmp-vendor-toggle]').click();if(findVendor()?.classList.contains('expanded'))return false;findVendor()?.querySelector('[data-cmp-vendor-toggle]')?.click();const expandedSeries=findSeries();const seriesToggle=expandedSeries?.querySelector('[data-cmp-series-toggle]');if(!seriesToggle)return false;seriesToggle.click();if(findSeries()?.classList.contains('expanded'))return false;findSeries()?.querySelector('[data-cmp-series-toggle]')?.click();return !!findSeries()?.querySelector('[data-cmp-pick]')})()`);
    await evaluate(client, `(()=>{const model=[...document.querySelectorAll('[data-cmp-pick]')].find(item=>item.textContent.toLowerCase().replace(/-/g,' ').includes('glm 5.3'));model?.click();return new Promise(resolve=>setTimeout(()=>resolve(true),500))})()`);
    await assertBrowser(client, '选择模型后显示对比结果', `document.querySelectorAll('#cmpChips [data-cmp-remove]').length>0&&document.querySelector('#cmpResults')?.innerText.trim().length>0`);
    await evaluate(client, `(async()=>{const payload=await fetch('data/comparison/integrated/index.json').then(response=>response.json());const hit=payload.series.flatMap(series=>series.members.map(member=>({series,member}))).find(item=>item.member.variants?.length>1);if(!hit)return false;const input=document.querySelector('#cmpModelSearch');input.value=hit.member.display;input.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,500));return true})()`);
    await assertBrowser(client, '多 revision 模型仍可切换', `(()=>{const select=document.querySelector('#cmpModelList select[data-cmp-revision]');if(!select||select.options.length<2)return false;select.selectedIndex=select.selectedIndex===0?1:0;select.dispatchEvent(new Event('change',{bubbles:true}));return document.querySelectorAll('#cmpChips [data-cmp-remove]').length>0})()`);
    await evaluate(client, `(async()=>{const payload=await fetch('data/comparison/integrated/data.json').then(response=>response.json());const hit=payload.models.find(model=>Object.values(model.degrees||{}).some(degrees=>Array.isArray(degrees)&&degrees.length>1));if(!hit)return true;const input=document.querySelector('#cmpModelSearch');input.value=hit.display;input.dispatchEvent(new Event('input',{bubbles:true}));await new Promise(resolve=>setTimeout(resolve,500));const button=[...document.querySelectorAll('[data-cmp-pick]')].find(item=>item.textContent.trim()===hit.display);if(button?.getAttribute('aria-pressed')!=='true')button?.click();await new Promise(resolve=>setTimeout(resolve,500));const trigger=document.querySelector('#cmpChips [data-cmp-variant]');if(!trigger)return false;trigger.click();return !!document.querySelector('#cmpVariantPopover')})()`);
    await assertBrowser(client, 'degree 变体切换后结果保留', `(()=>{const pop=document.querySelector('#cmpVariantPopover');if(!pop)return true;const slot=pop.querySelector('[data-cmp-variant-slot]');if(!slot)return false;slot.click();return document.querySelector('#cmpResults')?.innerText.trim().length>0})()`);
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
