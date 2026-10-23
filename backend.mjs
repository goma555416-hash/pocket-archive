const FOLDER_MIME = 'application/vnd.google-apps.folder';

function readCookie(name, cookieString = globalThis.document?.cookie || '') {
  for (const part of String(cookieString).split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) { try { return decodeURIComponent(value.join('=')); } catch { return ''; } }
  }
  return '';
}

export class BackendApiError extends Error {
  constructor(message, status = 0, code = 'request_failed') { super(message); this.name = 'BackendApiError'; this.status = status; this.code = code; }
}

export class PocketBackendClient {
  constructor({ fetchImpl, locationObject = globalThis.location, cookieReader = readCookie } = {}) {
    this.fetch = fetchImpl || ((...args) => globalThis.fetch(...args));
    this.location = locationObject; this.cookieReader = cookieReader; this.available = null; this.session = null;
  }

  async request(path, { method = 'GET', headers = {}, body, allowUnauthenticated = false, raw = false } = {}) {
    const requestHeaders = new Headers(headers); requestHeaders.set('Accept', raw ? '*/*' : 'application/json');
    if (!['GET', 'HEAD'].includes(method)) {
      const csrf = this.cookieReader('__Host-pa_csrf');
      if (csrf) requestHeaders.set('X-PA-CSRF', csrf);
    }
    const response = await this.fetch(path, { method, headers: requestHeaders, body, credentials: 'same-origin' });
    const contentType = response.headers.get('content-type') || '';
    if (response.status === 404 && !contentType.includes('application/json')) throw new BackendApiError('Pocket Archive 後端未部署', 404, 'backend_unavailable');
    if (!response.ok) {
      const result = contentType.includes('application/json') ? await response.json().catch(() => ({})) : {};
      if (allowUnauthenticated && response.status === 401) return { authenticated: false };
      if (result?.error?.code === 'reauth_required' && this.session) this.session.reauthRequired = true;
      throw new BackendApiError(result?.error?.message || `後端要求失敗（${response.status}）`, response.status, result?.error?.code);
    }
    return raw ? response : response.json();
  }

  async detectSession() {
    try {
      const result = await this.request('/api/session', { allowUnauthenticated: true });
      this.available = true; this.session = result.authenticated === false ? null : result; return { available: true, session: this.session };
    } catch (error) {
      if (error.code === 'backend_unavailable' || error instanceof TypeError) { this.available = false; this.session = null; return { available: false, session: null }; }
      this.available = true; throw error;
    }
  }

  beginAuthorization(returnTo = `${this.location?.pathname || '/'}${this.location?.search || ''}`) {
    this.location.assign(`/api/auth/start?return_to=${encodeURIComponent(returnTo)}`);
  }

  readSocialMetadata(url) { return this.request('/api/social/metadata', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) }); }
  ownerStatus() { return this.request('/api/owner/status'); }
  bootstrapOwner(token) { return this.request('/api/owner/bootstrap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) }); }
  listSessions() { return this.request('/api/sessions'); }
  logout() { return this.request('/api/logout', { method: 'POST' }); }
  revokeGrant() { return this.request('/api/auth/revoke', { method: 'POST' }); }
  revokeSession(id) { return this.request(`/api/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
  createCaptureCredential(name, expiresInDays = 180) { return this.request('/api/capture/credentials', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, expiresInDays }) }); }
  listCaptureCredentials() { return this.request('/api/capture/credentials'); }
  revokeCaptureCredential(id) { return this.request(`/api/capture/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
  claimCaptureJobs(limit = 20) { return this.request(`/api/capture/jobs/claim?limit=${encodeURIComponent(limit)}`, { method: 'POST' }); }
  async downloadCaptureImage(id, leaseVersion) { const response = await this.request(`/api/capture/jobs/${encodeURIComponent(id)}/content`, { raw: true, headers: { 'X-PA-Lease-Version': String(leaseVersion) } }); return response.blob(); }
  acknowledgeCaptureJob(id, result = 'saved', leaseVersion) { return this.request(`/api/capture/jobs/${encodeURIComponent(id)}/ack`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'completed', result, leaseVersion }) }); }
  retryCaptureJob(id, error = 'local_write_failed', leaseVersion) { return this.request(`/api/capture/jobs/${encodeURIComponent(id)}/ack`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'retry', error, leaseVersion }) }); }
}

export class BackendDriveApi {
  constructor(client) { this.client = client; }

  listFiles(options = {}) { return this.client.request('/api/drive/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options) }); }
  getFile(id) { return this.client.request(`/api/drive/files/${encodeURIComponent(id)}`); }
  createMetadata(metadata) { return this.client.request('/api/drive/files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(metadata) }); }
  updateMetadata(id, metadata) { return this.client.request(`/api/drive/files/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(metadata) }); }
  async updateContent(id, blob, { mimeType = blob?.type || 'application/octet-stream' } = {}) {
    return this.client.request(`/api/drive/files/${encodeURIComponent(id)}/content`, { method: 'PUT', headers: { 'Content-Type': mimeType, 'X-PA-Content-Length': String(blob?.size || 0) }, body: blob });
  }
  async createFile({ name, parentId, blob, mimeType = blob?.type || 'application/octet-stream', appProperties = {} }) {
    const metadata = await this.createMetadata({ name, mimeType, parents: parentId ? [parentId] : undefined, appProperties: { schema: '2.2', ...appProperties } });
    try { return await this.updateContent(metadata.id, blob, { mimeType }); }
    catch (error) { try { await this.trashFile(metadata.id); } catch { /* best-effort cleanup */ } throw error; }
  }
  async downloadFile(id) {
    const response = await this.client.request(`/api/drive/files/${encodeURIComponent(id)}/content`, { raw: true });
    return response.blob();
  }
  trashFile(id) { return this.updateMetadata(id, { trashed: true }); }
  aboutUser() { return this.client.request('/api/drive/about'); }
  createFolder(name, parentId = null, appRole = 'folder') { return this.createMetadata({ name, mimeType: FOLDER_MIME, parents: parentId ? [parentId] : undefined, appProperties: { paRole: appRole, schema: '2.2' } }); }
  async findOrCreateFolder(name, parentId = null, appRole = 'folder') {
    const found = await this.listFiles({ parentId, name, mimeType: FOLDER_MIME });
    return found.files?.find(file => file.appProperties?.paRole === appRole) || found.files?.[0] || this.createFolder(name, parentId, appRole);
  }
  async ensureWorkspace() {
    const root = await this.findOrCreateFolder('Pocket Archive', null, 'root'); const result = { root: root.id };
    for (const [key, name] of [['backups', 'Backups'], ['aiInbox', 'AI-Inbox'], ['aiResults', 'AI-Results'], ['sync', 'Sync']]) result[key] = (await this.findOrCreateFolder(name, root.id, key)).id;
    result.syncAttachments = (await this.findOrCreateFolder('Attachments', result.sync, 'syncAttachments')).id;
    return result;
  }
}

export function authResultFromLocation(locationObject = globalThis.location) {
  const url = new URL(locationObject.href); const result = url.searchParams.get('auth');
  if (!result) return null;
  url.searchParams.delete('auth'); globalThis.history?.replaceState?.(null, '', `${url.pathname}${url.search}${url.hash}`);
  return result;
}
