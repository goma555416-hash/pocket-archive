export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
const API_ROOT = 'https://www.googleapis.com/drive/v3';
const UPLOAD_ROOT = 'https://www.googleapis.com/upload/drive/v3';
const RETRYABLE = new Set([429, 500, 502, 503, 504]);

const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function escapeQuery(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function validClientId(value) {
  return /^[0-9]+-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/.test(String(value || '').trim());
}

export async function loadGoogleIdentity(documentObject = globalThis.document) {
  if (globalThis.google?.accounts?.oauth2) return globalThis.google;
  if (!documentObject) throw new Error('目前環境無法載入 Google Identity Services');
  const existing = documentObject.querySelector('script[data-google-identity]');
  if (existing) {
    await new Promise((resolve, reject) => {
      existing.addEventListener('load', resolve, { once: true });
      existing.addEventListener('error', () => reject(new Error('Google 登入元件載入失敗')), { once: true });
    });
    return globalThis.google;
  }
  await new Promise((resolve, reject) => {
    const script = documentObject.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.dataset.googleIdentity = 'true';
    script.onload = resolve;
    script.onerror = () => reject(new Error('Google 登入元件載入失敗；請檢查網路或內容阻擋設定'));
    documentObject.head.append(script);
  });
  if (!globalThis.google?.accounts?.oauth2) throw new Error('Google 登入元件未正確初始化');
  return globalThis.google;
}

export class GoogleAuthSession {
  constructor({ clientId, googleObject = null, now = () => Date.now() } = {}) {
    if (!validClientId(clientId)) throw new Error('請輸入有效的 Google OAuth Web Client ID');
    this.clientId = clientId.trim();
    this.googleObject = googleObject;
    this.now = now;
    this.token = null;
    this.expiresAt = 0;
    this.tokenClient = null;
  }

  async connect({ prompt = 'consent' } = {}) {
    const googleObject = this.googleObject || await loadGoogleIdentity();
    return new Promise((resolve, reject) => {
      this.tokenClient = googleObject.accounts.oauth2.initTokenClient({
        client_id: this.clientId,
        scope: DRIVE_SCOPE,
        include_granted_scopes: true,
        callback: response => {
          if (response?.error || !response?.access_token) {
            this.clear();
            reject(new Error(`Google 授權失敗：${response?.error_description || response?.error || '未取得存取權'}`));
            return;
          }
          this.token = response.access_token;
          this.expiresAt = this.now() + Math.max(0, Number(response.expires_in || 3600) - 60) * 1000;
          resolve(this.status());
        },
        error_callback: error => {
          this.clear();
          reject(new Error(`Google 授權視窗失敗：${error?.type || '未知錯誤'}`));
        }
      });
      this.tokenClient.requestAccessToken({ prompt });
    });
  }

  getAccessToken() {
    if (!this.token || this.now() >= this.expiresAt) {
      this.clear();
      throw new Error('Google Drive 授權已失效，請重新連結');
    }
    return this.token;
  }

  status() {
    return { connected: Boolean(this.token && this.now() < this.expiresAt), expiresAt: this.expiresAt || null };
  }

  clear() { this.token = null; this.expiresAt = 0; }

  async disconnect() {
    const token = this.token;
    this.clear();
    if (!token) return;
    const googleObject = this.googleObject || globalThis.google;
    await new Promise(resolve => googleObject?.accounts?.oauth2?.revoke?.(token, resolve) || resolve());
  }
}

export class DriveApiError extends Error {
  constructor(message, status = 0, details = null) {
    super(message); this.name = 'DriveApiError'; this.status = status; this.details = details;
  }
}

export class DriveApi {
  constructor({ getAccessToken, fetchImpl, sleep = delay, random = Math.random } = {}) {
    if (typeof getAccessToken !== 'function') throw new Error('Drive API 缺少授權提供者');
    const request = fetchImpl === undefined && typeof globalThis.fetch === 'function'
      ? (...args) => globalThis.fetch(...args)
      : fetchImpl;
    if (typeof request !== 'function') throw new Error('目前環境不支援網路請求');
    this.getAccessToken = getAccessToken;
    this.fetch = request;
    this.sleep = sleep;
    this.random = random;
  }

  async request(url, { method = 'GET', headers = {}, body, attempts = 4, raw = false, response: returnResponse = false } = {}) {
    let lastError;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      let response;
      try {
        response = await this.fetch(url, {
          method,
          headers: { Authorization: `Bearer ${this.getAccessToken()}`, ...headers },
          body
        });
      } catch (error) {
        lastError = new DriveApiError(`Google Drive 連線失敗：${error.message}`);
        if (attempt + 1 >= attempts) throw lastError;
        await this.sleep(300 * (2 ** attempt));
        continue;
      }
      if (response.ok) {
        if (returnResponse) return response;
        if (raw) return response.blob();
        if (response.status === 204) return null;
        return response.json();
      }
      let details = null;
      try { details = await response.json(); } catch { /* non-JSON provider error */ }
      const providerMessage = details?.error?.message || response.statusText || '未知錯誤';
      lastError = new DriveApiError(`Google Drive API ${response.status}：${providerMessage}`, response.status, details);
      if (response.status === 401) throw new DriveApiError('Google Drive 授權已失效，請重新連結', 401, details);
      if (!RETRYABLE.has(response.status) || attempt + 1 >= attempts) throw lastError;
      const retryAfter = Number(response.headers.get('retry-after'));
      const backoff = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : (400 * (2 ** attempt)) + Math.floor(this.random() * 200);
      await this.sleep(Math.min(backoff, 8000));
    }
    throw lastError;
  }

  listFiles({ parentId = null, name = null, appRole = null, mimeType = null, orderBy = 'modifiedTime desc', pageSize = 100 } = {}) {
    const clauses = ['trashed = false'];
    if (parentId) clauses.push(`'${escapeQuery(parentId)}' in parents`);
    if (name) clauses.push(`name = '${escapeQuery(name)}'`);
    if (appRole) clauses.push(`appProperties has { key='paRole' and value='${escapeQuery(appRole)}' }`);
    if (mimeType) clauses.push(`mimeType = '${escapeQuery(mimeType)}'`);
    const params = new URLSearchParams({
      q: clauses.join(' and '), spaces: 'drive', orderBy, pageSize: String(pageSize),
      fields: 'nextPageToken,files(id,name,mimeType,size,createdTime,modifiedTime,md5Checksum,version,appProperties,parents)'
    });
    return this.request(`${API_ROOT}/files?${params}`);
  }

  getFile(id) {
    const fields = 'id,name,mimeType,size,createdTime,modifiedTime,md5Checksum,version,appProperties,parents';
    return this.request(`${API_ROOT}/files/${encodeURIComponent(id)}?fields=${encodeURIComponent(fields)}`);
  }

  async createMetadata(metadata) {
    return this.request(`${API_ROOT}/files?fields=id,name,mimeType,size,createdTime,modifiedTime,md5Checksum,version,appProperties,parents`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(metadata)
    });
  }

  createFolder(name, parentId = null, appRole = 'folder') {
    return this.createMetadata({ name, mimeType: DRIVE_FOLDER_MIME, parents: parentId ? [parentId] : undefined, appProperties: { paRole: appRole, schema: '2.1' } });
  }

  async createFile({ name, parentId, blob, mimeType = blob?.type || 'application/octet-stream', appProperties = {} }) {
    const metadata = await this.createMetadata({ name, mimeType, parents: parentId ? [parentId] : undefined, appProperties: { schema: '2.1', ...appProperties } });
    try { return await this.updateContent(metadata.id, blob, { mimeType }); }
    catch (error) {
      try { await this.trashFile(metadata.id); } catch { /* best-effort cleanup of incomplete create */ }
      throw error;
    }
  }

  async updateContent(id, blob, { mimeType = blob?.type || 'application/octet-stream' } = {}) {
    const fields = 'id,name,mimeType,size,createdTime,modifiedTime,md5Checksum,version,appProperties,parents';
    if (blob?.size > 5 * 1024 * 1024) {
      const start = await this.request(`${UPLOAD_ROOT}/files/${encodeURIComponent(id)}?uploadType=resumable&fields=${encodeURIComponent(fields)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Upload-Content-Type': mimeType, 'X-Upload-Content-Length': String(blob.size) },
        body: '{}', response: true
      });
      const location = start.headers.get('location');
      if (!location) throw new DriveApiError('Google Drive 未回傳可續傳上傳位置');
      return this.request(location, {
        method: 'PUT', headers: { 'Content-Type': mimeType, 'Content-Range': `bytes 0-${blob.size - 1}/${blob.size}` }, body: blob
      });
    }
    return this.request(`${UPLOAD_ROOT}/files/${encodeURIComponent(id)}?uploadType=media&fields=${encodeURIComponent(fields)}`, {
      method: 'PATCH', headers: { 'Content-Type': mimeType }, body: blob
    });
  }

  updateMetadata(id, metadata) {
    return this.request(`${API_ROOT}/files/${encodeURIComponent(id)}?fields=id,name,mimeType,size,createdTime,modifiedTime,md5Checksum,version,appProperties,parents`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(metadata)
    });
  }

  downloadFile(id) { return this.request(`${API_ROOT}/files/${encodeURIComponent(id)}?alt=media`, { raw: true }); }
  trashFile(id) { return this.updateMetadata(id, { trashed: true }); }

  async aboutUser() {
    return this.request(`${API_ROOT}/about?fields=user(displayName,emailAddress,photoLink)`);
  }

  async findOrCreateFolder(name, parentId = null, appRole = 'folder') {
    const found = await this.listFiles({ parentId, name, mimeType: DRIVE_FOLDER_MIME });
    const matching = found.files?.find(file => file.appProperties?.paRole === appRole) || found.files?.[0];
    return matching || this.createFolder(name, parentId, appRole);
  }

  async ensureWorkspace() {
    const root = await this.findOrCreateFolder('Pocket Archive', null, 'root');
    const result = { root: root.id };
    for (const [key, name] of [['backups', 'Backups'], ['aiInbox', 'AI-Inbox'], ['aiResults', 'AI-Results'], ['sync', 'Sync']]) {
      result[key] = (await this.findOrCreateFolder(name, root.id, key)).id;
    }
    result.syncAttachments = (await this.findOrCreateFolder('Attachments', result.sync, 'syncAttachments')).id;
    return result;
  }
}

export function isValidGoogleClientId(value) { return validClientId(value); }
