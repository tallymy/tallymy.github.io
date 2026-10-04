// Snap receipts inside Tally: a live camera with a shutter, several photos in a row, the light, and the gallery.
import { t } from './i18n.js';
import { esc, ICON, openSheet, closeSheet, $, reduced } from './ui.js';
import { toGray, measure, hint } from './camcheck.js';

const pickPhotos = () => $('#scan-input').click();

/** Open the camera; `onFiles` gets the photos taken when it closes (Done, the X or Back). No camera: the photo picker. */
export function startScan(onFiles) {
  if (!navigator.mediaDevices?.getUserMedia) return pickPhotos();
  const shots = [];
  let stream = null, closed = false, capturing = false, successTimer = 0;
  const el = openSheet(`<div class="cam-view"><video playsinline muted autoplay></video><div class="cam-guide" aria-hidden="true"></div>
      <p class="cam-msg" role="status">${esc(t('Fit the whole receipt inside the frame'))}</p></div>
    <div class="cam-top"><button class="cam-ic" data-c="close" aria-label="${esc(t('Close camera'))}">${ICON.x}</button>
      <div class="cam-feedback"><b class="cam-count num" role="status" aria-live="polite" aria-atomic="true">${esc(t('{0} photos', 0))}</b><span class="cam-success" aria-hidden="true"></span></div>
      <button class="cam-ic" data-c="torch" aria-pressed="false" aria-label="${esc(t('Light'))}" hidden>${ICON.bolt}</button></div>
    <div class="cam-bar"><button class="cam-side" data-c="gallery">${ICON.image}<span>${esc(t('Gallery'))}</span></button>
      <button class="cam-shutter" data-c="snap" aria-label="${esc(t('Take a photo'))}" disabled></button>
      <button class="cam-side" data-c="done" disabled><b class="cam-n num"></b><span>${esc(t('Done'))}</span></button></div>`,
  { label: t('Camera'), onClose: () => { closed = true; clearTimeout(successTimer); stream?.getTracks().forEach(tr => tr.stop()); if (shots.length) onFiles(shots); } });
  el.closest('.scrim').classList.add('cam');
  const video = el.querySelector('video'), msg = el.querySelector('.cam-msg'), q = c => el.querySelector(`[data-c="${c}"]`);

  navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } } }).then(s => {
    if (closed) return s.getTracks().forEach(tr => tr.stop());
    stream = s; video.srcObject = s;
    video.addEventListener('loadedmetadata', () => { if (closed) return; q('snap').disabled = false; q('snap').focus(); watchFrame(); }, { once: true });   // a tap before the first frame would take nothing
    if (s.getVideoTracks()[0].getCapabilities?.().torch) q('torch').hidden = false;
  }).catch(() => {
    if (closed) return;
    msg.textContent = t("Tally can't use the camera. Allow the camera for Tally in your phone's or browser's settings, or pick photos from the gallery.");
    el.querySelector('.cam-view').classList.add('off');
    q('snap').hidden = q('done').hidden = true;   // no shutter to tap in vain: the gallery becomes the one big button
    q('gallery').classList.add('main');
  });

  // Live hints: what the camera sees, a few times a second. A hint shows once it holds for two looks (no flicker, and
  // a screen reader isn't read every change); the frame turns green when the receipt looks readable.
  const guide = el.querySelector('.cam-guide'), cv = document.createElement('canvas'), W = 480;
  const say = { dark: () => (q('torch').hidden ? t('Too dark. Find more light') : t('Too dark. Tap the light')), glare: () => t('Glare. Tilt the phone a little'), far: () => t('Move closer'),
    close: () => t('Move back to fit the whole receipt'), blurry: () => t('Blurry. Hold still'), ok: () => t('Looks good. Tap to snap') };
  let shown = null, seen = null, quiet = 0;
  const look = () => {
    // The whole picture the shutter keeps (not just the dashed frame: a receipt reaching past it still reads fine).
    const sw = video.videoWidth, sh = video.videoHeight;
    cv.width = W; cv.height = Math.min(900, Math.round(sh * W / sw));
    const x = cv.getContext('2d', { willReadFrequently: true });
    x.drawImage(video, 0, 0, sw, sh, 0, 0, cv.width, cv.height);
    return hint(measure(toGray(x.getImageData(0, 0, cv.width, cv.height).data), cv.width, cv.height));
  };
  const watchFrame = () => {
    if (closed) return;
    let h = null;
    try { if (video.videoWidth && Date.now() > quiet) h = look(); } catch {}
    if (h && h === seen && h !== shown) { shown = h; msg.setAttribute('aria-live', 'polite'); msg.textContent = say[h](); guide.classList.toggle('ok', h === 'ok'); guide.classList.toggle('warn', h !== 'ok'); }
    seen = h;
    setTimeout(watchFrame, 350);
  };

  el.addEventListener('click', async e => {
    const b = e.target.closest('[data-c]'); if (!b || b.disabled) return;
    const c = b.dataset.c;
    if (c === 'close' || c === 'done') return closeSheet();
    if (c === 'gallery') { closeSheet(); return pickPhotos(); }   // still inside the tap, so the picker may open
    if (c === 'torch') {
      const on = b.getAttribute('aria-pressed') !== 'true';
      await stream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: on }] }).then(() => b.setAttribute('aria-pressed', on), () => {});
      return;
    }
    if (c === 'snap' && video.videoWidth && !closed && !capturing) {
      capturing = true; q('snap').disabled = true;
      const frame = document.createElement('canvas');
      try {
        frame.width = video.videoWidth; frame.height = video.videoHeight;
        frame.getContext('2d').drawImage(video, 0, 0);
        const blob = await new Promise(resolve => frame.toBlob(resolve, 'image/jpeg', 0.92));
        if (!blob?.size || closed) return;
        shots.push(new File([blob], `receipt-${Date.now()}.jpg`, { type: 'image/jpeg' }));
        if (!reduced()) el.querySelector('.cam-view').animate([{ opacity: .2 }, { opacity: 1 }], { duration: 180 });
        el.querySelector('.cam-count').textContent = shots.length === 1 ? t('1 photo') : t('{0} photos', shots.length);
        el.querySelector('.cam-success').textContent = t('Photo added');
        el.querySelector('.cam-n').textContent = shots.length;
        q('done').disabled = false;
        msg.setAttribute('aria-live', 'off'); // The changing top count announces each capture once; hints remain live.
        msg.textContent = t('{0} taken. Snap the next receipt, or tap Done.', shots.length);
        quiet = Date.now() + 2000; shown = null;
        clearTimeout(successTimer);
        successTimer = setTimeout(() => { if (!closed) el.querySelector('.cam-success').textContent = ''; }, 2000);
      } catch {
        if (!closed) { msg.setAttribute('aria-live', 'polite'); msg.textContent = t('Could not take this photo. Try again.'); }
      } finally {
        frame.width = frame.height = 0; capturing = false;
        if (!closed) q('snap').disabled = false;
      }
    }
  });
}
