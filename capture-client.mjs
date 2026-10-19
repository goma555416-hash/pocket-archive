import { ALLOWED_IMAGE_TYPES, createCaptureEntry, hasValidImageSignature, sha256 } from './lib.mjs';

export async function imageDimensions(blob) {
  if (typeof globalThis.createImageBitmap !== 'function') return { width: null, height: null };
  try {
    const bitmap = await createImageBitmap(blob); const result = { width: bitmap.width, height: bitmap.height }; bitmap.close(); return result;
  } catch { return { width: null, height: null }; } // HEIC remains an original downloadable blob.
}

export async function receiveCaptureJob(job, backend, repository, deviceId) {
  let blob = null;
  if (job.kind === 'image') {
    const meta = job.attachment;
    if (!meta || !ALLOWED_IMAGE_TYPES.has(meta.mimeType) || !Number.isSafeInteger(meta.size) || meta.size < 1 || meta.size > 4 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(meta.hash)) throw new Error('圖片收件 metadata 無效');
    blob = await backend.downloadCaptureImage(job.id, job.attemptCount);
    if (blob.size !== meta.size || blob.type !== meta.mimeType || !hasValidImageSignature(new Uint8Array(await blob.slice(0, 64).arrayBuffer()), meta.mimeType) || await sha256(blob) !== meta.hash) throw new Error('圖片收件大小、MIME 或 SHA-256 不符；不寫入、不確認');
    job = { ...job, attachment: { ...meta, ...await imageDimensions(blob) } };
  }
  const entry = createCaptureEntry(job);
  // Receipt, original blob, entry, journal and dirty flag commit in ONE transaction.
  const result = await repository.commitCapture(entry, blob, deviceId);
  await backend.acknowledgeCaptureJob(job.id, result, job.attemptCount);
  return result;
}
