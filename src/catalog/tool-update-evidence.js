'use strict';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTHS = Object.freeze({
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4,
  may: 5, june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8,
  september: 9, sep: 9, october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
});
const MONTH_TOKEN = '(January|Jan|February|Feb|March|Mar|April|Apr|May|June|Jun|July|Jul|August|Aug|September|Sep|October|Oct|November|Nov|December|Dec)';
const ORDINAL = '(?:st|nd|rd|th)?';

function isIsoDate(value) {
  if (!DATE_PATTERN.test(String(value || ''))) return false;
  const [year, month, day] = String(value).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function isoDateFromValue(value) {
  const match = String(value || '').match(/(?:^|\b)(20\d{2})-(\d{2})-(\d{2})(?=\b|T)/);
  const date = match ? `${match[1]}-${match[2]}-${match[3]}` : null;
  return date && isIsoDate(date) ? date : null;
}

function dateFromParts(year, month, day) {
  const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isIsoDate(date) ? date : null;
}

function explicitDates(text) {
  const value = String(text || '');
  const dates = new Set();
  for (const match of value.matchAll(/(?:^|\b)(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})(?=\b|T)/g)) {
    const date = dateFromParts(Number(match[1]), Number(match[2]), Number(match[3]));
    if (date) dates.add(date);
  }
  for (const match of value.matchAll(new RegExp(`\\b${MONTH_TOKEN}(?:\\.|\\s)+\\s*(\\d{1,2})${ORDINAL},?\\s+(20\\d{2})\\b`, 'gi'))) {
    const date = dateFromParts(Number(match[3]), MONTHS[match[1].toLowerCase()], Number(match[2]));
    if (date) dates.add(date);
  }
  for (const match of value.matchAll(new RegExp(`\\b(\\d{1,2})${ORDINAL}\\s+${MONTH_TOKEN}\\s+(20\\d{2})\\b`, 'gi'))) {
    const date = dateFromParts(Number(match[3]), MONTHS[match[2].toLowerCase()], Number(match[1]));
    if (date) dates.add(date);
  }
  for (const match of value.matchAll(new RegExp(`(?:^|[^\\w])\\s*${MONTH_TOKEN}\\.?\\s+(20\\d{2})[\\s\\S]{0,200}?\\b${MONTH_TOKEN}(?:\\.|\\s)+\\s*(\\d{1,2})${ORDINAL}\\b`, 'gi'))) {
    if (MONTHS[match[1].toLowerCase()] === MONTHS[match[3].toLowerCase()]) {
      const date = dateFromParts(Number(match[2]), MONTHS[match[3].toLowerCase()], Number(match[4]));
      if (date) dates.add(date);
    }
  }
  for (const match of value.matchAll(/\b(20\d{2})年(\d{1,2})月(\d{1,2})日\b/g)) {
    const date = dateFromParts(Number(match[1]), Number(match[2]), Number(match[3]));
    if (date) dates.add(date);
  }
  return [...dates];
}

function officialDateOf(value) {
  return isoDateFromValue(value);
}

function dateForEvidence(evidence = {}, maybeOptions = {}, legacyOptions = {}) {
  const options = Object.keys(legacyOptions).length ? legacyOptions : maybeOptions;
  const metadataDate = officialDateOf(evidence.official_published_at);
  if (metadataDate) return { date: metadataDate, source: 'official_published_at' };

  const excerptDates = explicitDates(evidence.excerpt);
  if (options.latest) {
    return excerptDates.length
      ? { date: [...new Set(excerptDates)].sort().at(-1), source: 'excerpt' }
      : { date: null, reason: 'EVIDENCE_DATE_MISSING' };
  }
  if (excerptDates.length > 1) return { date: null, reason: 'EVIDENCE_DATE_AMBIGUOUS' };
  if (excerptDates.length === 1) return { date: excerptDates[0], source: 'excerpt' };
  return { date: null, reason: 'EVIDENCE_DATE_MISSING' };
}

module.exports = {
  DATE_PATTERN,
  isIsoDate,
  isoDateFromValue,
  officialDateOf,
  explicitDates,
  dateForEvidence,
};
