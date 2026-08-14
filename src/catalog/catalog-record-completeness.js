'use strict';

const { ALLOWED_FIELDS } = require('./catalog-contract');

const NOT_APPLICABLE_STATUS = 'not_applicable';
const FORBIDDEN_PLACEHOLDERS = new Set(['unknown', '未知', '资料状态未知', '待核验', 'n/a', 'na']);

function addError(errors, code, path, message) {
  errors.push({ code, path, message });
}

function isExplicitValue(value) {
  return typeof value === 'string' && value.trim().length > 0 && !FORBIDDEN_PLACEHOLDERS.has(value.trim().toLowerCase());
}

function walkDefaults(value, path, errors) {
  if (value === null || value === undefined) return addError(errors, 'GENERATED_DEFAULT_FORBIDDEN', path, '生成记录禁止 null/undefined');
  if (typeof value === 'string') {
    if (!isExplicitValue(value) && value !== NOT_APPLICABLE_STATUS) addError(errors, 'GENERATED_DEFAULT_FORBIDDEN', path, '生成记录禁止空值或 unknown/未知');
    return;
  }
  if (Array.isArray(value)) {
    if (!value.length) addError(errors, 'GENERATED_DEFAULT_FORBIDDEN', path, '生成记录禁止空数组');
    value.forEach((item, index) => walkDefaults(item, `${path}[${index}]`, errors));
    return;
  }
  if (typeof value === 'object') Object.entries(value).forEach(([field, nested]) => walkDefaults(nested, `${path}.${field}`, errors));
}

function validatePlannedRecords(recordsByArea) {
  const errors = [];
  Object.entries(recordsByArea || {}).forEach(([area, records]) => {
    (records || []).forEach((record, index) => {
      const basePath = `${area}[${index}]`;
      (ALLOWED_FIELDS[area] || []).forEach(field => {
        if (!Object.prototype.hasOwnProperty.call(record, field)) addError(errors, 'GENERATED_FIELD_MISSING', `${basePath}.${field}`, '生成记录缺少契约字段');
      });
      walkDefaults(record, basePath, errors);
    });
  });
  return { ok: errors.length === 0, errors };
}

module.exports = {
  NOT_APPLICABLE_STATUS,
  FORBIDDEN_PLACEHOLDERS,
  isExplicitValue,
  validatePlannedRecords,
};
