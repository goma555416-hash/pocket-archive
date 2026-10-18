import { validatedEntry } from './lib.mjs';

export const SYNC_FORMAT = 'pocket-archive-sync-journal';
export const SYNC_VERSION = 1;

function cleanClock(clock) {
  const result = {};
  if (!clock || typeof clock !== 'object' || Array.isArray(clock)) return result;
  for (const [device, value] of Object.entries(clock).slice(0, 64)) {
    if (/^[A-Za-z0-9._:-]{1,128}$/.test(device) && Number.isSafeInteger(value) && value >= 0) result[device] = value;
  }
  return result;
}

export function mergeClocks(...clocks) {
  const merged = {};
  for (const clock of clocks) for (const [device, value] of Object.entries(cleanClock(clock))) merged[device] = Math.max(merged[device] || 0, value);
  return merged;
}

export function compareClocks(left, right) {
  const a = cleanClock(left); const b = cleanClock(right);
  let greater = false; let less = false;
  for (const device of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const av = a[device] || 0; const bv = b[device] || 0;
    if (av > bv) greater = true;
    if (av < bv) less = true;
  }
  if (greater && less) return 'concurrent';
  if (greater) return 'dominates';
  if (less) return 'dominated';
  return 'equal';
}

export function bumpClock(clock, deviceId) {
  const next = mergeClocks(clock); next[deviceId] = (next[deviceId] || 0) + 1; return next;
}

function withoutSync(entry) {
  const { sync, ...value } = entry || {}; return value;
}

function sameContent(left, right) { return JSON.stringify(withoutSync(left)) === JSON.stringify(withoutSync(right)); }

export function makeUpsertRecord(entry, deviceId, now = new Date().toISOString(), baseClock = entry?.sync?.clock) {
  const value = validatedEntry({ ...entry, sync: { clock: bumpClock(baseClock, deviceId), modifiedAt: now, modifiedBy: deviceId } });
  return { record: { itemId: value.id, operation: 'upsert', clock: value.sync.clock, modifiedAt: now, modifiedBy: deviceId, entry: value }, entry: value };
}

export function makeDeleteRecord(entry, deviceId, now = new Date().toISOString()) {
  return { itemId: entry.id, operation: 'delete', clock: bumpClock(entry.sync?.clock, deviceId), modifiedAt: now, modifiedBy: deviceId };
}

export function recordLocalChanges(before, after, { deviceId, journal = {}, tombstones = {}, now = new Date().toISOString() }) {
  const previous = new Map(before.map(entry => [entry.id, entry]));
  const nextEntries = [];
  const nextJournal = { ...journal }; const nextTombstones = { ...tombstones };
  for (const raw of after) {
    const current = validatedEntry(raw); const prior = previous.get(current.id);
    if (!prior || !sameContent(prior, current)) {
      const { record, entry } = makeUpsertRecord(current, deviceId, now, prior?.sync?.clock || current.sync?.clock);
      nextEntries.push(entry); nextJournal[entry.id] = record; delete nextTombstones[entry.id];
    } else nextEntries.push(current);
    previous.delete(current.id);
  }
  for (const removed of previous.values()) {
    const record = makeDeleteRecord(removed, deviceId, now);
    nextJournal[removed.id] = record; nextTombstones[removed.id] = record;
  }
  return { entries: nextEntries, journal: nextJournal, tombstones: nextTombstones };
}

function validRecord(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.itemId !== 'string' || !['upsert', 'delete'].includes(raw.operation)) throw new Error('同步紀錄格式錯誤');
  const record = { itemId: raw.itemId, operation: raw.operation, clock: cleanClock(raw.clock), modifiedAt: String(raw.modifiedAt || ''), modifiedBy: String(raw.modifiedBy || '') };
  if (!Object.keys(record.clock).length || Number.isNaN(Date.parse(record.modifiedAt))) throw new Error('同步紀錄缺少版本資訊');
  if (record.operation === 'upsert') {
    record.entry = validatedEntry({ ...raw.entry, sync: { clock: record.clock, modifiedAt: record.modifiedAt, modifiedBy: record.modifiedBy } });
    if (typeof raw.attachmentFileId === 'string' && /^[A-Za-z0-9_-]{4,256}$/.test(raw.attachmentFileId)) record.attachmentFileId = raw.attachmentFileId;
  }
  return record;
}

export function createJournal(deviceId, records, updatedAt = new Date().toISOString()) {
  return { format: SYNC_FORMAT, schema_version: SYNC_VERSION, device_id: deviceId, updated_at: updatedAt, records: Object.values(records).map(validRecord) };
}

export function readJournal(value) {
  const data = typeof value === 'string' ? JSON.parse(value) : value;
  if (!data || data.format !== SYNC_FORMAT || data.schema_version !== SYNC_VERSION || typeof data.device_id !== 'string' || !Array.isArray(data.records)) throw new Error('同步日誌格式或版本不受支援');
  return { deviceId: data.device_id, updatedAt: data.updated_at, records: data.records.map(validRecord) };
}

function localRecord(entry, tombstone) {
  if (tombstone) return validRecord(tombstone);
  if (!entry?.sync?.clock || !Object.keys(entry.sync.clock).length) return null;
  return validRecord({ itemId: entry.id, operation: 'upsert', clock: entry.sync.clock, modifiedAt: entry.sync.modifiedAt || entry.updatedAt, modifiedBy: entry.sync.modifiedBy || '', entry });
}

function remoteWins(local, remote) {
  if (local.operation === 'delete' && remote.operation === 'upsert') return true;
  if (local.operation === 'upsert' && remote.operation === 'delete') return false;
  return `${remote.modifiedAt}\u0000${remote.modifiedBy}` > `${local.modifiedAt}\u0000${local.modifiedBy}`;
}

export function reconcileReplica(entries, tombstones = {}, remoteRecords = []) {
  const byId = new Map(entries.map(entry => [entry.id, validatedEntry(entry)]));
  const deleted = { ...tombstones }; const conflicts = []; let applied = 0;
  for (const raw of remoteRecords) {
    const remote = validRecord(raw); const local = localRecord(byId.get(remote.itemId), deleted[remote.itemId]);
    if (!local) {
      if (remote.operation === 'upsert') { byId.set(remote.itemId, remote.entry); delete deleted[remote.itemId]; }
      else deleted[remote.itemId] = remote;
      applied += 1; continue;
    }
    const relation = compareClocks(local.clock, remote.clock);
    if (relation === 'dominates' || relation === 'equal') continue;
    if (relation === 'dominated') {
      if (remote.operation === 'delete') { byId.delete(remote.itemId); deleted[remote.itemId] = remote; }
      else { byId.set(remote.itemId, remote.entry); delete deleted[remote.itemId]; }
      applied += 1; continue;
    }
    const chooseRemote = remoteWins(local, remote);
    conflicts.push({ itemId: remote.itemId, local, remote, chosen: chooseRemote ? 'remote' : 'local' });
    if (chooseRemote) {
      if (remote.operation === 'delete') { byId.delete(remote.itemId); deleted[remote.itemId] = remote; }
      else { byId.set(remote.itemId, remote.entry); delete deleted[remote.itemId]; }
      applied += 1;
    }
  }
  return { entries: [...byId.values()], tombstones: deleted, conflicts, applied };
}

export function resolveConflict(conflict, choice, deviceId, now = new Date().toISOString()) {
  if (!['local', 'remote'].includes(choice)) throw new Error('衝突處理選項無效');
  const selected = conflict[choice]; const mergedClock = mergeClocks(conflict.local.clock, conflict.remote.clock);
  if (selected.operation === 'delete') return { record: { ...selected, clock: bumpClock(mergedClock, deviceId), modifiedAt: now, modifiedBy: deviceId }, entry: null };
  return makeUpsertRecord(selected.entry, deviceId, now, mergedClock);
}
