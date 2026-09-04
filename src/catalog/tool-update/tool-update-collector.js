'use strict';

const crypto = require('crypto');
const {
  updateSourcesForProduct,
  validateUpdateSource,
} = require('../url-registry/official-url-registry');
const { canonicalizeUrl, extractTavily } = require('../../shared/tavily-client');
const { explicitDates } = require('./tool-update-evidence');
const { htmlToText, sameSourceOrigin, fetchHtmlText } = require('./html-collector');

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_RAW_BASE = 'https://raw.githubusercontent.com';
const GITHUB_REPOSITORY_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const GITHUB_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const GITHUB_PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._+@-]+$/;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 250;
const MAX_EXCERPT_CHARS = 4000;
const DEFAULT_USER_AGENT = 'KnowView-tool-update-collector/0.1';

function errorResult(code, error, extra = {}) {
  return { ok: false, code, error, ...extra };
}

function repositoryOf(value) {
  const repository = String(value || '').trim();
  if (!GITHUB_REPOSITORY_PATTERN.test(repository)) return null;
  const [owner, name] = repository.split('/');
  return { repository, owner, name };
}

function headerOf(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) || '');
  const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key] || '') : '';
}

function retryableStatus(status) {
  return status === 429 || status >= 500;
}

function rateLimitDiagnostics(response) {
  const remaining = headerOf(response?.headers, 'x-ratelimit-remaining');
  const reset = headerOf(response?.headers, 'x-ratelimit-reset');
  return {
    ...(remaining ? { rate_limit_remaining: remaining } : {}),
    ...(reset ? { rate_limit_reset: reset } : {}),
  };
}

function sleepFor(options, milliseconds) {
  return (options.sleepImpl || (ms => new Promise(resolve => setTimeout(resolve, ms))))(milliseconds);
}

async function requestWithRetry(url, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') return errorResult('UPDATE_COLLECTOR_FETCH_UNAVAILABLE', '当前运行环境无 fetch');
  const retries = Number.isInteger(options.retries) ? Math.max(0, Math.min(options.retries, 3)) : DEFAULT_RETRIES;
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Math.max(1, Number(options.timeoutMs)) : DEFAULT_TIMEOUT_MS;
  const responseType = options.responseType || 'json';
  let lastFailure = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    let response;
    let timer;
    try {
      const controller = new AbortController();
      timer = setTimeout(() => controller.abort(), timeoutMs);
      response = await fetchImpl(url, {
        method: 'GET',
        headers: {
          'User-Agent': options.userAgent || DEFAULT_USER_AGENT,
          Accept: responseType === 'json' ? 'application/vnd.github+json' : 'text/plain, text/markdown, */*',
        },
        redirect: 'follow',
        signal: controller.signal,
      });
    } catch (error) {
      const timeout = error?.name === 'AbortError' || error?.name === 'TimeoutError' || error?.code === 'ETIMEDOUT';
      lastFailure = errorResult(timeout ? 'UPDATE_COLLECTOR_TIMEOUT' : 'UPDATE_COLLECTOR_NETWORK_ERROR', String(error?.message || error), {
        attempts: attempt + 1,
      });
      if (attempt < retries) {
        await sleepFor(options, DEFAULT_RETRY_BASE_MS * (attempt + 1));
        continue;
      }
      return lastFailure;
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (!response?.ok) {
      const status = Number(response?.status || 0);
      const diagnostics = { attempts: attempt + 1, status, ...rateLimitDiagnostics(response) };
      let code = status === 401 ? 'GITHUB_AUTH_REQUIRED'
        : status === 403 && diagnostics.rate_limit_remaining === '0' ? 'GITHUB_RATE_LIMITED'
          : status === 403 ? 'GITHUB_FORBIDDEN'
            : status === 404 ? 'GITHUB_NOT_FOUND'
              : status === 429 ? 'GITHUB_RATE_LIMITED'
                : `GITHUB_HTTP_${status || 'UNKNOWN'}`;
      if (retryableStatus(status) && attempt < retries) {
        await sleepFor(options, DEFAULT_RETRY_BASE_MS * (attempt + 1));
        continue;
      }
      let detail = '';
      try { detail = String(await response.text()).slice(0, 240); } catch {}
      return errorResult(code, `GitHub 请求失败: HTTP ${status || 'unknown'}${detail ? `: ${detail}` : ''}`, diagnostics);
    }

    try {
      if (responseType === 'text') {
        const text = String(await response.text() || '');
        if (!text.trim()) return errorResult('GITHUB_EMPTY_BODY', 'GitHub 响应正文为空', { attempts: attempt + 1 });
        return { ok: true, text, diagnostics: { attempts: attempt + 1, status: Number(response.status || 200) } };
      }
      const data = await response.json();
      return { ok: true, data, diagnostics: { attempts: attempt + 1, status: Number(response.status || 200) } };
    } catch (error) {
      return errorResult(responseType === 'json' ? 'GITHUB_INVALID_JSON' : 'GITHUB_EMPTY_BODY', String(error?.message || error), {
        attempts: attempt + 1,
      });
    }
  }

  return lastFailure || errorResult('UPDATE_COLLECTOR_FAILED', '采集失败');
}

function releaseHumanUrl(value, repository) {
  const url = canonicalizeUrl(value);
  const parsedRepository = repositoryOf(repository);
  if (!url || !parsedRepository) return '';
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com') return '';
    if (parts.length < 4 || parts[0].toLowerCase() !== parsedRepository.owner.toLowerCase() || parts[1].toLowerCase() !== parsedRepository.name.toLowerCase() || parts[2].toLowerCase() !== 'releases') return '';
    return url;
  } catch {
    return '';
  }
}

function fileTargetFromSource(source) {
  const repository = repositoryOf(source.repository);
  const url = canonicalizeUrl(source.url);
  if (!repository || !url) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com') return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 5 || parts[2].toLowerCase() !== 'blob') return null;
  if (parts[0].toLowerCase() !== repository.owner.toLowerCase() || parts[1].toLowerCase() !== repository.name.toLowerCase()) return null;
  const ref = parts[3];
  const filePath = parts.slice(4).join('/');
  if (!GITHUB_REF_PATTERN.test(ref)) return null;
  if (!filePath || filePath.split('/').some(segment => !GITHUB_PATH_SEGMENT_PATTERN.test(segment))) return null;
  return { repository: repository.repository, ref, filePath, url };
}

function excerptOf(content) {
  return String(content || '').trim().slice(0, MAX_EXCERPT_CHARS);
}

function hashOf(content) {
  return `sha256:${crypto.createHash('sha256').update(String(content || ''), 'utf8').digest('hex')}`;
}

function collectedAtOf(options) {
  if (options.now !== undefined) return String(options.now);
  return new Date().toISOString();
}

function titleFromUrl(url) {
  try {
    const parsed = new URL(url);
    const segment = parsed.pathname.split('/').filter(Boolean).pop() || parsed.hostname;
    return decodeURIComponent(segment).replace(/[-_]+/g, ' ').replace(/\.[A-Za-z0-9]+$/, '').trim() || parsed.hostname;
  } catch {
    return String(url || 'official update source');
  }
}

function evidenceOf(productKey, source, values, options = {}) {
  return {
    product_key: String(productKey),
    detail_id: String(values.detailId),
    source_type: source.kind,
    collector: source.collector,
    url: canonicalizeUrl(values.url),
    title: String(values.title || titleFromUrl(values.url)).trim(),
    official_published_at: values.officialPublishedAt || null,
    excerpt: excerptOf(values.content),
    content_hash: hashOf(values.content),
    collected_at: collectedAtOf(options),
    status: values.status || 'ready',
    diagnostics: {
      ...(values.diagnostics || {}),
      ...(values.status === 'discovery_only' ? { discovery_only: true } : {}),
    },
  };
}

async function collectGithubRelease(productKey, source, options = {}) {
  const repository = repositoryOf(source.repository);
  if (!repository) return errorResult('GITHUB_REPOSITORY_INVALID', 'repository 不符合 owner/repo 白名单');
  const endpoint = `${GITHUB_API_BASE}/repos/${repository.repository}/releases?per_page=100`;
  const result = await requestWithRetry(endpoint, { ...options, responseType: 'json' });
  if (!result.ok) return result;
  if (!Array.isArray(result.data)) return errorResult('GITHUB_RELEASES_SCHEMA_INVALID', 'GitHub releases 响应不是数组', result.diagnostics);

  const candidates = result.data
    .filter(release => release && release.draft !== true && (source.include_prerelease === true || release.prerelease !== true))
    .filter(release => !source.tag_prefix || (typeof release.tag_name === 'string' && release.tag_name.startsWith(source.tag_prefix)))
    .sort((left, right) => Date.parse(String(right.published_at || '')) - Date.parse(String(left.published_at || '')));
  if (!candidates.length) return errorResult('GITHUB_RELEASE_NO_ELIGIBLE', '没有符合 prerelease/draft/tag prefix 门禁的 Release', result.diagnostics);

  const release = candidates[0];
  const humanUrl = releaseHumanUrl(release.html_url, repository.repository);
  if (!humanUrl) return errorResult('GITHUB_RELEASE_HTML_URL_INVALID', 'Release html_url 不是对应仓库的 github.com Release 网页', result.diagnostics);
  const content = String(release.body || '').trim();
  const publishedAt = Date.parse(String(release.published_at || ''));
  if (!content) {
    if (Number.isNaN(publishedAt)) {
      return errorResult('GITHUB_RELEASE_BODY_EMPTY', 'Release 正文为空且无官方发布时间', result.diagnostics);
    }
    // 正文为空但有官方 published_at：版本发布本身即官方更新，日期来自官方发布元数据。
    return {
      ok: true,
      evidence: evidenceOf(productKey, source, {
        detailId: `${productKey}:${String(release.tag_name || release.id || 'release')}`,
        url: humanUrl,
        title: release.name || release.tag_name || 'GitHub Release',
        officialPublishedAt: release.published_at,
        content: release.name || release.tag_name || 'GitHub Release',
        status: 'ready',
        diagnostics: {
          ...result.diagnostics,
          repository: repository.repository,
          tag_name: String(release.tag_name || ''),
          draft: release.draft === true,
          prerelease: release.prerelease === true,
          body_empty: true,
        },
      }, options),
    };
  }
  const status = Number.isNaN(publishedAt) ? 'discovery_only' : 'ready';
  return {
    ok: true,
    evidence: evidenceOf(productKey, source, {
      detailId: `${productKey}:${String(release.tag_name || release.id || 'release')}`,
      url: humanUrl,
      title: release.name || release.tag_name || 'GitHub Release',
      officialPublishedAt: status === 'ready' ? release.published_at : null,
      content,
      status,
      diagnostics: {
        ...result.diagnostics,
        repository: repository.repository,
        tag_name: String(release.tag_name || ''),
        draft: release.draft === true,
        prerelease: release.prerelease === true,
        ...(status === 'discovery_only' ? { reason: 'published_at_missing_or_invalid' } : {}),
      },
    }, options),
  };
}

async function collectGithubFile(productKey, source, options = {}) {
  const target = fileTargetFromSource(source);
  if (!target) return errorResult('GITHUB_FILE_TARGET_INVALID', 'GitHub file URL、repository、ref 或 path 不符合白名单');
  const endpoint = `${GITHUB_RAW_BASE}/${target.repository}/${encodeURIComponent(target.ref)}/${target.filePath.split('/').map(encodeURIComponent).join('/')}`;
  const result = await requestWithRetry(endpoint, { ...options, responseType: 'text' });
  if (!result.ok) return result;
  const content = String(result.text || '').trim();
  if (!content) return errorResult('GITHUB_FILE_EMPTY', 'GitHub 文件正文为空', result.diagnostics);
  return {
    ok: true,
    evidence: evidenceOf(productKey, source, {
      detailId: `${productKey}:${target.repository}:${target.ref}:${target.filePath}`,
      url: target.url,
      title: target.filePath.split('/').pop(),
      officialPublishedAt: null,
      content,
      status: 'ready',
      diagnostics: {
        ...result.diagnostics,
        repository: target.repository,
        ref: target.ref,
        path: target.filePath,
      },
    }, options),
  };
}

async function collectTavilySource(productKey, source, options = {}) {
  const url = canonicalizeUrl(source.url);
  // 优先直接抓取官方页面 HTML：Tavily Extract 对 JS 渲染/缓存页经常丢失 changelog 条目日期。
  // 仅当 HTML 文本能解析出至少一个日期时才采用，否则回退 Tavily Extract（HTML 可能是 JS 空壳/反爬页）。
  const html = await fetchHtmlText(url, options);
  if (html.ok && html.final_url && !sameSourceOrigin(url, html.final_url)) {
    return errorResult('UPDATE_HTML_REDIRECT_UNTRUSTED', '官方更新源重定向到了不同产品域名', {
      source_url: url,
      final_url: html.final_url,
    });
  }
  if (html.ok && explicitDates(html.text).length) {
    return {
      ok: true,
      evidence: evidenceOf(productKey, source, {
        detailId: `${productKey}:${url}`,
        url,
        title: titleFromUrl(url),
        officialPublishedAt: null,
        content: html.text,
        status: 'ready',
        diagnostics: { collector: 'tavily_extract', html_fallback: true },
      }, options),
    };
  }
  const result = await extractTavily({
    ...options,
    urls: [url],
    query: undefined,
  });
  if (!result.ok) return result;
  const match = result.contents.find(content => canonicalizeUrl(content.url) === url && String(content.content || '').trim());
  if (!match) {
    const failed = result.failed.find(item => canonicalizeUrl(item.url) === url);
    return errorResult('TAVILY_EXTRACT_SOURCE_EMPTY', failed?.error || 'Tavily Extract 未返回目标来源正文', {
      html_error: html.error || null,
      failed_results: result.failed,
      usage: result.usage || null,
    });
  }
  return {
    ok: true,
    evidence: evidenceOf(productKey, source, {
      detailId: `${productKey}:${url}`,
      url,
      title: titleFromUrl(url),
      officialPublishedAt: null,
      content: match.content,
      status: 'ready',
      diagnostics: {
        collector: 'tavily_extract',
        usage: result.usage || null,
      },
    }, options),
  };
}

async function collectUpdateEvidence(productKey, source, options = {}) {
  const validationErrors = validateUpdateSource(source, productKey, options.sourceIndex || 0);
  if (validationErrors.length) return errorResult('UPDATE_SOURCE_INVALID', '更新源未通过 registry 契约校验', { errors: validationErrors });
  if (source.collector === 'github_web_release') return collectGithubRelease(productKey, source, options);
  if (source.collector === 'github_web_file') return collectGithubFile(productKey, source, options);
  if (source.collector === 'tavily_extract') return collectTavilySource(productKey, source, options);
  return errorResult('UPDATE_COLLECTOR_UNSUPPORTED', `不支持的 collector: ${source.collector}`);
}

async function collectProductUpdateEvidence(productKey, options = {}) {
  const sources = updateSourcesForProduct(productKey, { registry: options.registry });
  if (!sources.length) return errorResult('UPDATE_SOURCE_NOT_FOUND', `产品没有登记 update_sources: ${productKey}`);
  const evidence = [];
  const failed = [];
  for (let index = 0; index < sources.length; index += 1) {
    const result = await collectUpdateEvidence(productKey, sources[index], { ...options, sourceIndex: index });
    if (result.ok) evidence.push(result.evidence);
    else failed.push({ source: sources[index], ...result });
  }
  return {
    ok: failed.length === 0,
    product_key: String(productKey),
    evidence,
    failed,
  };
}

module.exports = {
  GITHUB_API_BASE,
  GITHUB_RAW_BASE,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_RETRIES,
  canonicalRepository: repositoryOf,
  fileTargetFromSource,
  htmlToText,
  fetchHtmlText,
  collectGithubRelease,
  collectGithubFile,
  collectTavilySource,
  collectUpdateEvidence,
  collectProductUpdateEvidence,
};
