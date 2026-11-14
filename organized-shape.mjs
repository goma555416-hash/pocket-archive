// Structure-only validation of an organized.json for a known AI job.
// Needs no collection content, so the Worker can run it without storing
// URLs/notes. The App still runs the full readOrganized check at preview.
import { validateEvidenceShape } from './content-evidence.mjs';

function fail(code, message) { const error = new Error(message); error.code = code; throw error; }

export function checkOrganizedForJob(text, { exportId, itemIds, maxBytes = 2 * 1024 * 1024 } = {}) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > maxBytes) fail('result_too_large', '整理結果過大');
  let data;
  try { data = JSON.parse(text); } catch { fail('result_invalid_json', '整理結果不是有效 JSON'); }
  if (!data || data.format !== 'pocket-archive-organized' || data.schema_version !== 2 || !Array.isArray(data.items)) fail('result_schema', '整理結果格式或 schema 不符');
  if (data.source_export_id !== exportId) fail('result_export_mismatch', '整理結果的 export_id 不符');
  const expected = new Set(itemIds || []);
  const received = new Set(data.items.map(item => item?.id));
  if (!expected.size || received.size !== data.items.length || received.size !== expected.size || [...received].some(id => !expected.has(id))) {
    fail('result_ids_mismatch', '整理結果的項目必須與批次完整一對一');
  }
  for (const item of data.items) {
    if (item.evidence === undefined) fail('result_evidence', `項目 ${item.id} 缺少內容證據`);
    try { validateEvidenceShape(item.evidence, item); } catch (error) { fail('result_evidence', `項目 ${item.id}：${error.message}`); }
  }
  return { items: data.items };
}
