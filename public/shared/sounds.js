/* ===== Bermuda Sort Station — ok/error beeps (Web Audio, no asset files) ===== */
let ctx;
function tone(freq, ms) {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator(), gain = ctx.createGain();
    osc.frequency.value = freq;
    osc.connect(gain); gain.connect(ctx.destination);
    gain.gain.setValueAtTime(0.15, ctx.currentTime);
    osc.start();
    osc.stop(ctx.currentTime + ms / 1000);
  } catch { /* audio not available — silent is fine, the screen still shows the result */ }
}
export const beepOk = () => tone(880, 120);
export const beepError = () => tone(220, 250);
