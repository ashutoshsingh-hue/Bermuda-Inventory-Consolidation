/* Phone camera scanning for the station screen. Only offered where the browser allows a camera
   (HTTPS or localhost). Decoded text is handed to onCode() exactly like a hardware scan - always a string. */
let reader = null;
let lastCode = '';
let lastAt = 0;

export function initCamera(btn, overlay, video, closeBtn, onCode) {
  if (!navigator.mediaDevices || !window.ZXing) return;
  btn.classList.remove('hidden');

  const stop = () => {
    if (reader) { reader.reset(); reader = null; }
    overlay.classList.add('hidden');
  };

  btn.addEventListener('click', async () => {
    const Z = window.ZXing;
    const hints = new Map();
    hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.CODE_39,
      Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A, Z.BarcodeFormat.ITF, Z.BarcodeFormat.QR_CODE]);
    hints.set(Z.DecodeHintType.TRY_HARDER, true);
    reader = new Z.BrowserMultiFormatReader(hints, 100);
    overlay.classList.remove('hidden');
    try {
      await reader.decodeFromConstraints(
        { video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } },
        video,
        (result) => {
          if (!result) return;
          const code = String(result.getText());
          const now = Date.now();
          if (code === lastCode && now - lastAt < 2000) { lastAt = now; return; }
          lastCode = code; lastAt = now;
          if (navigator.vibrate) navigator.vibrate(60);
          onCode(code);
        });
    } catch (e) {
      stop();
      alert('Camera unavailable: ' + e.message);
    }
  });
  closeBtn.addEventListener('click', stop);
}
