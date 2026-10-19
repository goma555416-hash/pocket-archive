// Original blobs only. Native modal supplies focus containment and Escape on Safari/desktop.
export function createImageViewer(dialog, { getAttachment, returnFocus = () => document.querySelector('#search-input') }) {
  const image = dialog.querySelector('img'); const surface = dialog.querySelector('.viewer-surface');
  const status = dialog.querySelector('[role="status"]'); const link = dialog.querySelector('a');
  let url = null; let generation = 0; let opener; let zoom = 1; let fit = 1; let naturalWidth = 0; let naturalHeight = 0;
  const pointers = new Map(); let gesture;
  function resize(next = 1) {
    const oldWidth = image.width || 1; const oldHeight = image.height || 1;
    const cx = (surface.scrollLeft + surface.clientWidth / 2) / oldWidth;
    const cy = (surface.scrollTop + surface.clientHeight / 2) / oldHeight;
    zoom = Math.max(1, Math.min(8, next));
    image.style.width = `${naturalWidth * fit * zoom}px`; image.style.height = `${naturalHeight * fit * zoom}px`;
    surface.scrollLeft = cx * image.width - surface.clientWidth / 2; surface.scrollTop = cy * image.height - surface.clientHeight / 2;
    dialog.querySelector('[data-zoom="reset"]').textContent = `${Math.round(zoom * 100)}% · 重設`;
  }
  function cleanup() {
    generation++; image.onload = null; image.onerror = null;
    image.removeAttribute('src'); image.hidden = true; link.removeAttribute('href'); link.hidden = true;
    if (url) URL.revokeObjectURL(url); url = null; pointers.clear(); gesture = null;
  }
  function close() { cleanup(); if (dialog.open) dialog.close(); }
  dialog.addEventListener('close', () => {
    // Native close events are queued. An earlier close must not clear a reopened viewer.
    if (dialog.open) return;
    cleanup(); (opener?.isConnected ? opener : returnFocus())?.focus();
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.querySelector('[data-viewer-close]').addEventListener('click', close);
  dialog.querySelectorAll('[data-zoom]').forEach(button => button.addEventListener('click', () => resize(button.dataset.zoom === 'reset' ? 1 : zoom * (button.dataset.zoom === 'in' ? 1.5 : 1 / 1.5))));
  surface.addEventListener('keydown', event => {
    if (['+', '=', '-', '0'].includes(event.key)) { event.preventDefault(); resize(event.key === '0' ? 1 : zoom * (event.key === '-' ? 1 / 1.5 : 1.5)); }
  });
  function startGesture() {
    const points = [...pointers.values()];
    gesture = points.length === 1 ? { x: points[0].x, y: points[0].y, left: surface.scrollLeft, top: surface.scrollTop } : points.length > 1 ? { distance: Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y), zoom } : null;
  }
  surface.addEventListener('pointerdown', event => { if (event.pointerType === 'mouse' && event.button !== 0) return; pointers.set(event.pointerId, { x: event.clientX, y: event.clientY }); surface.setPointerCapture(event.pointerId); startGesture(); });
  surface.addEventListener('pointermove', event => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY }); const points = [...pointers.values()];
    if (points.length > 1 && gesture?.distance) resize(gesture.zoom * Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) / gesture.distance);
    else if (gesture) { surface.scrollLeft = gesture.left - (event.clientX - gesture.x); surface.scrollTop = gesture.top - (event.clientY - gesture.y); }
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) surface.addEventListener(name, event => { pointers.delete(event.pointerId); startGesture(); });
  return {
    async open(entry, trigger) {
      cleanup(); const token = generation; opener = trigger; zoom = 1; image.hidden = true; naturalWidth = naturalHeight = 0;
      dialog.querySelector('h2').textContent = entry.title; status.textContent = '正在讀取原始附件…';
      if (!dialog.open) dialog.showModal(); dialog.querySelector('[data-viewer-close]').focus();
      try {
        if (!entry.attachment) throw new Error('沒有原始附件');
        const blob = await getAttachment(entry.attachment.id); if (generation !== token) return;
        if (!blob) throw new Error('原始附件遺失，請從完整備份還原');
        url = URL.createObjectURL(blob); link.href = url; link.download = entry.attachment.name; link.hidden = false;
        image.onload = () => {
          if (generation !== token) return;
          naturalWidth = image.naturalWidth; naturalHeight = image.naturalHeight;
          fit = Math.min(1, Math.max(1, surface.clientWidth - 24) / naturalWidth, Math.max(1, surface.clientHeight - 24) / naturalHeight);
          image.hidden = false; resize(1); surface.scrollLeft = surface.scrollTop = 0;
          status.textContent = `${entry.attachment.name} · ${naturalWidth} × ${naturalHeight}；原圖未轉檔。可用按鈕、雙指縮放及拖移，或鍵盤 + / − / 0 與方向鍵。`;
        };
        image.onerror = () => { if (generation === token) { image.hidden = true; status.textContent = '瀏覽器無法解碼此圖片（含部分 HEIC／HEIF）。原檔仍完整保留，請下載原檔後開啟。'; } };
        image.alt = `原始圖片：${entry.title}`; image.src = url;
      } catch (error) { if (generation === token) status.textContent = error.message; }
    },
    dispose: close
  };
}
