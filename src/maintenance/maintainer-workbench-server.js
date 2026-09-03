'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { createMaintainerWorkbenchService } = require('./maintainer-workbench-service');

const API_PREFIX = '/api/workbench/v1';
const MAX_BODY_BYTES = 32 * 1024;
const TRANSCRIPT_UPLOAD_MAX_BYTES = 3 * 1024 * 1024;
const MIME_TYPES = Object.freeze({ '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' });
const SAFE_ERROR_CODES = new Set([
  'BAD_REQUEST', 'OPERATION_FAILED', 'PENDING_CANDIDATE_NOT_FOUND', 'PENDING_CANDIDATE_NOT_APPROVED',
  'COST_CONFIRMATION_REQUIRED', 'PLAN_CHANGED', 'CONFIRMATION_INVALID', 'DRAFT_BLOCKED', 'DRAFT_ID_INVALID',
  'PREVIEW_CHANGED', 'PREVIEW_INVALID', 'PREVIEW_CANDIDATES_INVALID', 'PREVIEW_SCHEMA_UNSUPPORTED',
  'REVISION_CONFLICT', 'BATCH_TOKEN_CHANGED', 'BATCH_TOKEN_EXPIRED', 'DRAFT_BATCH_STALE', 'SOURCE_PENDING_REVISION_CHANGED',
  'DRAFT_IDS_INVALID', 'DRAFTS_NOT_READY',
  'RECOVERY_OPTIONS_INVALID', 'MODEL_REQUIRED', 'RECOVERY_TOKEN_REQUIRED', 'RECOVERY_TOKEN_CHANGED', 'DRAFT_RECOVERY_FORBIDDEN', 'DRAFT_RECOVERY_IN_PROGRESS',
  'CONCEPT_TERM_NOT_FOUND', 'CONCEPT_TERM_ALREADY_EXISTS', 'CONCEPT_PREVIEW_INCOMPLETE', 'CONCEPT_TERMS_REQUIRED',
  'CONCEPT_TERMS_INVALID', 'CONCEPT_APPLY_MODE_INVALID', 'PENDING_REVIEW_DECISION_INVALID', 'PENDING_FILE_INVALID', 'PENDING_KIND_INVALID',
  'PENDING_CANDIDATE_NAME_REQUIRED', 'PENDING_CANDIDATE_VAGUE', 'PENDING_DETAIL_KIND_INVALID', 'WORKBENCH_NOT_COMPLETE',
]);

function randomToken() { return crypto.randomBytes(32).toString('base64url'); }
function commonHeaders() {
  return {
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; object-src 'none'",
  };
}
function staticWhitelist(root) {
  const files = new Map();
  if (!fs.existsSync(root)) return files;
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile()) {
        const relative = path.relative(root, file).split(path.sep).join('/');
        if (MIME_TYPES[path.extname(relative).toLowerCase()]) files.set(`/${relative}`, file);
      }
    }
  }
  visit(root);
  if (files.has('/index.html')) files.set('/', files.get('/index.html'));
  return files;
}
function send(res, status, payload, extra = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { ...commonHeaders(), 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), ...extra });
  res.end(body);
}
function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '').toLowerCase();
    if (!type.startsWith('application/json')) return reject(Object.assign(new Error('Content-Type 必须为 application/json'), { status: 415 }));
    let bytes = 0;
    let exceeded = false;
    const chunks = [];
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        if (!exceeded) {
          exceeded = true;
          reject(Object.assign(new Error(`请求体超过 ${Math.round(maxBytes / 1024)}KiB`), { status: 413 }));
        }
      } else if (!exceeded) chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('JSON 无效'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function expectedOrigin(req, address) {
  return `http://127.0.0.1:${address.port}`;
}
function authorizeMutation(req, token, address) {
  if (req.headers.authorization !== `Bearer ${token}`) return false;
  return req.headers.origin === expectedOrigin(req, address);
}

function createMaintainerWorkbenchServer(options = {}) {
  const host = options.host || '127.0.0.1';
  if (host !== '127.0.0.1') throw new Error('维护者工作台只能绑定 127.0.0.1');
  const token = options.token || randomToken();
  const service = options.service || createMaintainerWorkbenchService(options);
  const staticFiles = options.staticFiles || staticWhitelist(options.staticRoot || path.resolve(__dirname, '..', 'maintainer-web'));
  let server;
  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const method = req.method || 'GET';
    let cleanupRequestSignal = () => {};
    try {
      if (url.pathname.startsWith(API_PREFIX)) {
        const route = url.pathname.slice(API_PREFIX.length);
        if (method !== 'GET' && method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' }, { Allow: 'GET, POST' });
        if (method === 'POST' && !authorizeMutation(req, token, server.address())) return send(res, 403, { error: 'FORBIDDEN' });
        let requestSignal = null;
        if (method === 'POST' && route === '/news/transcripts/summarize') {
          const controller = new AbortController();
          const abortRequest = () => controller.abort();
          const abortResponse = () => {
            if (!res.writableEnded) controller.abort();
          };
          req.once('aborted', abortRequest);
          res.once('close', abortResponse);
          requestSignal = controller.signal;
          cleanupRequestSignal = () => {
            req.removeListener('aborted', abortRequest);
            res.removeListener('close', abortResponse);
          };
        }
        const body = method === 'POST' ? await readJsonBody(req, route === '/news/transcripts/upload' ? TRANSCRIPT_UPLOAD_MAX_BYTES : MAX_BODY_BYTES) : null;
        let result;
        if (method === 'GET' && route === '/overview') result = service.overview();
        else if (method === 'POST' && route === '/workbench/clear') result = service.clearWorkspace();
        else if (method === 'GET' && route === '/news/review') result = service.newsReview();
        else if (method === 'POST' && route === '/news/review') result = service.reviewNews(body);
        else if (method === 'POST' && route === '/news/repair') result = service.repairNews(body);
        else if (method === 'GET' && route === '/news/keywords') result = service.keywords();
        else if (method === 'POST' && route === '/news/keywords/generate') result = service.generateKeywords();
        else if (method === 'POST' && route === '/news/keywords') result = service.applyKeywords(body);
        else if (method === 'POST' && route === '/news/keywords/discard') result = service.discardKeywords(body);
        else if (method === 'GET' && route === '/news/top') result = service.top();
        else if (method === 'POST' && route === '/news/top/generate') result = service.generateTop();
        else if (method === 'POST' && route === '/news/top') result = service.applyTop(body);
        else if (method === 'POST' && route === '/news/publish') result = service.publishNews();
        else if (method === 'POST' && route === '/news/transcripts/upload') result = service.uploadTranscript(body);
        else if (method === 'POST' && route === '/news/transcripts/summarize') result = service.summarizeTranscripts(body, { signal: requestSignal });
        else if (method === 'GET' && route === '/news/publish-preview') result = service.publishPreview();
        else if (method === 'GET' && route === '/tool-updates') result = service.toolUpdates();
        else if (method === 'GET' && route === '/tool-updates/preview') result = service.previewToolUpdates();
        else if (method === 'POST' && route === '/tool-updates/apply') result = service.applyToolUpdates(body);
        else if (method === 'POST' && /^\/tool-updates\/[^/]+\/review$/.test(route)) result = service.reviewToolUpdate(decodeURIComponent(route.split('/')[2]), body);
        else if (method === 'GET' && route === '/feedback/tools') result = service.pendingTools();
        else if (method === 'GET' && route === '/feedback/concepts') result = service.pendingConcepts();
        else if (method === 'POST' && /^\/feedback\/tools\/[^/]+\/review$/.test(route)) result = service.reviewPendingTool(decodeURIComponent(route.split('/')[3]), body);
        else if (method === 'POST' && /^\/feedback\/concepts\/[^/]+\/review$/.test(route)) result = service.reviewPendingConcept(decodeURIComponent(route.split('/')[3]), body);
        else if (method === 'POST' && route === '/knowledge/extract') result = service.extractKnowledge(body);
        else if (method === 'GET' && route === '/catalog/plan') result = service.catalogPlan();
        else if (method === 'POST' && route === '/catalog/prepare') result = service.catalogPrepare(body);
        else if (method === 'GET' && route === '/catalog/drafts') result = service.catalogDrafts();
        else if (method === 'GET' && /^\/catalog\/drafts\/[^/]+$/.test(route)) result = service.catalogDraft(decodeURIComponent(route.split('/')[3]));
        else if (method === 'POST' && /^\/catalog\/drafts\/[^/]+\/review$/.test(route)) result = service.catalogReview(decodeURIComponent(route.split('/')[3]));
        else if (method === 'POST' && /^\/catalog\/drafts\/[^/]+\/recovery-plan$/.test(route)) result = service.catalogRecoveryPlan(decodeURIComponent(route.split('/')[3]), body);
        else if (method === 'POST' && /^\/catalog\/drafts\/[^/]+\/resume$/.test(route)) result = service.catalogResume(decodeURIComponent(route.split('/')[3]), body);
        else if (method === 'POST' && /^\/catalog\/drafts\/[^/]+\/discard$/.test(route)) result = service.catalogDiscard(decodeURIComponent(route.split('/')[3]), body);
        else if (method === 'GET' && route === '/catalog/batch-preview') result = service.catalogBatchPreview();
        else if (method === 'POST' && route === '/catalog/apply-batch') result = service.catalogApplyBatch(body);
        else if (method === 'POST' && route === '/catalog/apply') result = service.catalogApply(body);
        else if (method === 'GET' && route === '/concepts/plan') result = service.conceptPlan();
        else if (method === 'POST' && route === '/concepts/prepare') result = service.conceptPrepare(body);
        else if (method === 'POST' && route === '/concepts/apply') result = service.conceptApply(body);
        else if (method === 'GET' && route === '/concepts/preview') result = service.conceptPreviews();
        else return send(res, 404, { error: 'NOT_FOUND' });
        result = await result;
        if (res.destroyed || res.writableEnded) return;
        if (result && result.ok === false) {
          const conflict = new Set(['REVISION_CONFLICT', 'PREVIEW_CHANGED', 'BATCH_TOKEN_CHANGED', 'BATCH_TOKEN_EXPIRED', 'DRAFT_BATCH_STALE', 'SOURCE_PENDING_REVISION_CHANGED', 'PLAN_CHANGED', 'RECOVERY_TOKEN_CHANGED', 'RECOVERY_PLAN_CHANGED']);
          return send(res, conflict.has(result.code) ? 409 : 400, result);
        }
        return send(res, 200, result);
      }
      if (method !== 'GET') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' }, { Allow: 'GET' });
      const file = staticFiles.get(url.pathname);
      if (!file) return send(res, 404, { error: 'NOT_FOUND' });
      const content = fs.readFileSync(file);
      res.writeHead(200, { ...commonHeaders(), 'Content-Type': MIME_TYPES[path.extname(file).toLowerCase()], 'Content-Length': content.length });
      return res.end(content);
    } catch (error) {
      if (res.destroyed || res.writableEnded) return;
      if (error?.code === 'REVISION_CONFLICT') {
        return send(res, 409, { error: 'REVISION_CONFLICT', message: '数据已变化，请刷新后重试。' });
      }
      const status = Number.isInteger(error?.status) ? error.status : 400;
      if (status === 413) return send(res, 413, { error: 'PAYLOAD_TOO_LARGE' });
      if (status === 415) return send(res, 415, { error: 'UNSUPPORTED_MEDIA_TYPE' });
      const code = SAFE_ERROR_CODES.has(error?.code) ? error.code : 'OPERATION_FAILED';
      const message = typeof error?.message === 'string' && error.message.length > 0 ? error.message : code;
      return send(res, status, { error: code, message });
    } finally {
      cleanupRequestSignal();
    }
  }
  server = http.createServer(handle);
  return {
    server, token, host,
    start(port = 0) { return new Promise(resolve => server.listen(port, host, () => { const address = server.address(); resolve({ host, port: address.port, url: `http://${host}:${address.port}/#token=${encodeURIComponent(token)}` }); })); },
    close() { return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}

module.exports = { API_PREFIX, MAX_BODY_BYTES, createMaintainerWorkbenchServer, staticWhitelist, randomToken };
