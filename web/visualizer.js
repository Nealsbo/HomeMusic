const waveCanvas = $('audioWave');
const waveDrawing = waveCanvas.getContext?.('2d');
const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)');
const audioAnalysis = new AudioAnalysis(audio,{
  createContext:() => { const Context = window.AudioContext || window.webkitAudioContext; return Context ? new Context() : null; }
});
let waveMode = stored('waveMode','off');
let waveLastMode = stored('waveLastMode','eco');
if (!['eco','smooth','high'].includes(waveLastMode)) waveLastMode = 'eco';
const waveMessages = {
  active:"Wave follows the music", off:"Animation is off", idle:"Waiting for playback",
  reduced:"Animation disabled by system preferences", gesture:"Press play or enable the wave",
  unavailable:"Visualization is unavailable in this browser"
};
const audioWave = new AudioWave(audio, {
  smoothing: 0.4, // 0 = No height smoothing at 0, current at 1, softer at 2; fractional values are supported.
  analysis:audioAnalysis,
  hidden:() => !waveDrawing || document.hidden || $('wavePanel').hidden || !!globalThis.expandedPlayer?.isOpen,
  reduced:() => !!reducedMotion?.matches,
  schedule:(callback,delay) => setTimeout(callback,delay), cancel:id => clearTimeout(id),
  status:state => { $('waveStatus').textContent = tr(waveMessages[state]); },
  draw:(levels,active) => {
    if (!waveDrawing) return;
    const w = waveCanvas.width, h = waveCanvas.height;
    waveDrawing.clearRect(0,0,w,h);
    waveDrawing.fillStyle = getComputedStyle(waveCanvas).color;
    waveDrawing.globalAlpha = active ? .85 : .3;
    const step = w / levels.length;
    levels.forEach((level,i) => {
      const height = Math.max(3, level * (h - 6));
      waveDrawing.fillRect(i * step + step * .2,(h - height) / 2,step * .6,height);
    });
  }
});
function setWaveMode(value, gesture = false) {
  waveMode = ['off','eco','smooth','high'].includes(value) ? value : 'off';
  store('waveMode',waveMode);
  if (waveMode !== 'off') { waveLastMode = waveMode; store('waveLastMode',waveMode); }
  $('waveModeSetting').value = waveMode;
  $('waveToggle').setAttribute('aria-pressed',String(waveMode !== 'off'));
  $('waveToggle').textContent = waveMode === 'off' ? tr("Enable wave") : tr("Disable wave");
  audioWave.setMode(waveMode);
  if (gesture) audioWave.unlock();
}
$('waveModeSetting').onchange = e => setWaveMode(e.target.value,true);
$('waveToggle').onclick = () => setWaveMode(waveMode === 'off' ? waveLastMode : 'off',true);
for (const event of ['playing','pause','waiting','seeking','seeked','emptied','loadstart','ended','error']) {
  audio.addEventListener(event,() => audioAnalysis.media(event));
}
audio.addEventListener('play',() => audioWave.unlock());
// Capturing user gestures also resumes an existing audio graph after mobile interruptions.
for (const event of ['pointerdown','keydown']) document.addEventListener?.(event,() => audioWave.unlock(),{capture:true});
document.addEventListener?.('visibilitychange',() => audioWave.sync());
document.addEventListener?.('expanded-player-change',() => audioWave.sync());
window.addEventListener('pageshow',() => audioWave.sync());
window.addEventListener('pagehide',() => audioWave.stop());
reducedMotion?.addEventListener?.('change',() => audioWave.sync());
setWaveMode(waveMode);
