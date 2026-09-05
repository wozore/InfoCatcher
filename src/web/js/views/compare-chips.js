/**
 * compare-chips.js — 模型已选标签（chips）与 360° 变体选择圆圈弹层
 */

import { t } from '../ui/i18n.js';
import { escapeHtml } from '../ui/ui-helpers.js';
import { brandIconHtml } from '../ui/brand-icons.js';
import { SOURCE_ORDER, SOURCE_META } from './compare-dimensions.js';

function modelIconHtml(model) {
  const meta = { vendorKey: model.vendor, toolKey: model.canonical, modelKey: model.canonical, emoji: '✦' };
  return brandIconHtml(meta);
}

function normalizeLmarena(x) {
  const value = ((Number(x) + 0.3) / 0.5) * 100;
  return Math.max(0, Math.min(100, value));
}

function sourcePrimaryScore(model, source, degree) {
  if (source === 'lmarena' && model.lmarena_scores?.agent?.[degree]) {
    return normalizeLmarena(model.lmarena_scores.agent[degree].score);
  }
  if (source === 'livebench' && model.livebench_scores?.[degree]?.reasoning != null) {
    return model.livebench_scores[degree].reasoning;
  }
  return null;
}

export function unionDegrees(model) {
  const seen = new Map();
  for (const source of SOURCE_ORDER) {
    const degrees = model.degrees?.[source] || [];
    if (degrees.length < 2) continue;
    for (const degree of degrees) {
      const key = String(degree).toLowerCase();
      if (!seen.has(key)) seen.set(key, { degree, sources: [] });
      seen.get(key).sources.push(source);
    }
  }
  return [...seen.values()];
}

export function setActiveVariants(model, degree, activeVariants) {
  const changes = [];
  for (const source of SOURCE_ORDER) {
    const sourceDegrees = model.degrees?.[source] || [];
    const match = sourceDegrees.find(item => String(item).toLowerCase() === String(degree).toLowerCase());
    if (!match) continue;
    const previous = activeVariants[model.canonical]?.[source] ?? model.default_degree?.[source];
    if (previous === match) continue;
    const beforeScore = sourcePrimaryScore(model, source, previous);
    const afterScore = sourcePrimaryScore(model, source, match);
    activeVariants[model.canonical] = { ...(activeVariants[model.canonical] || {}), [source]: match };
    if (beforeScore != null && afterScore != null) {
      changes.push({ source, previous, beforeScore, afterScore });
    }
  }
  return changes;
}

export function variantNoteFor(model, changes, activeVariants) {
  return changes.map(change => t('compare.variantSwitch', {
    model: model.display,
    degree: activeVariants[model.canonical]?.[change.source] || change.previous,
    source: SOURCE_META[change.source]?.label || change.source,
    before: change.beforeScore.toFixed(1),
    after: change.afterScore.toFixed(1),
  })).join(' ');
}

export function degreeLabelFor(model, activeVariants) {
  const active = activeVariants[model.canonical] || {};
  const parts = SOURCE_ORDER.filter(source => model.degrees?.[source]?.length).map(source => {
    const degree = active[source] || model.default_degree?.[source] || model.degrees[source][0];
    return (SOURCE_META[source]?.label || source) + ': ' + degree;
  });
  return parts.join(' · ');
}

export function renderChips(selected, activeVariants, variantOpenFor, indexMap, modelCapValue) {
  const box = document.getElementById('cmpChips');
  const count = document.getElementById('cmpCount');
  if (!box) return;
  if (count) count.textContent = t('compare.modelCapLabel', { n: selected.length, cap: modelCapValue });
  if (!selected.length) {
    box.innerHTML = '<p class="hint">' + escapeHtml(t('compare.empty.noSelection')) + '</p>';
    return;
  }
  box.innerHTML = selected.map(canonical => {
    const index = indexMap.get(canonical);
    if (!index) return '';
    return '<span class="cmp-chip">' +
      '<button class="cmp-chip-icon" type="button" data-cmp-variant="' + escapeHtml(canonical) + '" aria-label="' + escapeHtml(t('compare.variantOf') + index.display) + '" aria-expanded="' + (variantOpenFor === canonical) + '">' + modelIconHtml(index) + '</button>' +
      '<span class="cmp-chip-body"><span class="cmp-chip-name">' + escapeHtml(index.display) + '</span>' +
      '<span class="cmp-chip-degrees">' + escapeHtml(degreeLabelFor(index, activeVariants)) + '</span></span>' +
      '<button class="cmp-chip-remove" type="button" data-cmp-remove="' + escapeHtml(canonical) + '" aria-label="' + escapeHtml(t('compare.removeModel')) + '">×</button>' +
    '</span>';
  }).join('');
}

export function degreeIsActive(canonical, degree, activeVariants, indexMap) {
  const model = indexMap.get(canonical);
  if (!model) return false;
  return SOURCE_ORDER.some(source => {
    const active = activeVariants[canonical]?.[source] || model.default_degree?.[source];
    return active && String(active).toLowerCase() === String(degree).toLowerCase();
  });
}

export function positionPopover(pop, trigger, size) {
  const panel = document.getElementById('compareModelPanel');
  if (!panel || !trigger) return;
  const panelRect = panel.getBoundingClientRect();
  const iconRect = trigger.getBoundingClientRect();
  const left = iconRect.left - panelRect.left + iconRect.width / 2 - size / 2;
  const top = iconRect.bottom - panelRect.top + 10;
  pop.style.left = Math.max(8, left) + 'px';
  pop.style.top = (top + size + 16 > panelRect.height ? Math.max(8, iconRect.top - panelRect.top - size - 8) : top) + 'px';
}

export function renderVariantPopover(trigger, canonical, activeVariants, indexMap) {
  const model = indexMap.get(canonical);
  const existing = document.getElementById('cmpVariantPopover');
  if (existing) existing.remove();
  if (!model) return;
  const circle = unionDegrees(model);
  if (!circle.length) return;

  const pop = document.createElement('div');
  pop.id = 'cmpVariantPopover';
  pop.dataset.model = canonical;
  pop.className = 'cmp-variant-popover';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', t('compare.variantOf') + model.display);

  const N = circle.length;
  const size = 280;
  const cx = size / 2;
  const cy = size / 2;
  const inner = 34;
  const outer = 82;
  const labelR = 104;
  let sectors = '';
  for (let i = 0; i < N; i++) {
    const a0 = -Math.PI / 2 + (i * 2 * Math.PI) / N;
    const a1 = -Math.PI / 2 + ((i + 1) * 2 * Math.PI) / N;
    const selectedDegree = degreeIsActive(canonical, circle[i].degree, activeVariants, indexMap);
    const x0 = cx + inner * Math.cos(a0); const y0 = cy + inner * Math.sin(a0);
    const x1 = cx + outer * Math.cos(a0); const y1 = cy + outer * Math.sin(a0);
    const x2 = cx + outer * Math.cos(a1); const y2 = cy + outer * Math.sin(a1);
    const x3 = cx + inner * Math.cos(a1); const y3 = cy + inner * Math.sin(a1);
    const large = (a1 - a0) > Math.PI ? 1 : 0;
    const path = 'M' + x1 + ',' + y1 + ' A' + outer + ',' + outer + ' 0 ' + large + ' 1 ' + x2 + ',' + y2 +
      ' L' + x3 + ',' + y3 + ' A' + inner + ',' + inner + ' 0 ' + large + ' 0 ' + x0 + ',' + y0 + ' Z';
    const am = (a0 + a1) / 2;
    const lx = cx + labelR * Math.cos(am);
    const ly = cy + labelR * Math.sin(am);
    sectors += '<g class="cmp-variant-sector' + (selectedDegree ? ' selected' : '') + '" data-cmp-variant-slot="' + escapeHtml(circle[i].degree) + '" data-cmp-variant-model="' + escapeHtml(canonical) + '" role="button" tabindex="0" aria-label="' + escapeHtml(circle[i].degree) + '">' +
      '<path d="' + path + '"></path>' +
      '<text x="' + lx + '" y="' + ly + '" text-anchor="middle" dominant-baseline="middle">' + escapeHtml(circle[i].degree) + '</text></g>';
  }
  pop.innerHTML = '<button class="cmp-variant-close" type="button" data-cmp-variant-close aria-label="' + escapeHtml(t('compare.removeModel')) + '">×</button>' +
    '<p class="cmp-variant-hint">' + escapeHtml(t('compare.variantHint', { n: N })) + '</p>' +
    '<svg class="cmp-variant-svg" viewBox="0 0 ' + size + ' ' + size + '" role="img" aria-label="' + escapeHtml(model.display + ' 变体选择') + '">' + sectors + '</svg>';

  const panel = document.getElementById('compareModelPanel');
  if (panel) panel.appendChild(pop);
  positionPopover(pop, trigger, 306);
}
