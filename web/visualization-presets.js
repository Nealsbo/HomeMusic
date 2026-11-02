/* Bounded Canvas renderers. Input is sampled data, never playback state or audio. */
(function(root) {
  const presets = Object.freeze([
    {id:'classic-bars',label:'Classic bars',description:'Segmented spectrum with falling peaks, inspired by Winamp.'},
    {id:'neon-scope',label:'Neon scope',description:'Glowing oscilloscope on a dark grid, inspired by Winamp.'},
    {id:'ribbon-waves',label:'Ribbon waves',description:'Flowing audio ribbons, inspired by Windows Media Player.'},
    {id:'radial-bloom',label:'Radial bloom',description:'Circular spectrum and light rings, inspired by Windows Media Player.'},
    {id:'mirror-spectrum',label:'Mirror spectrum',description:'Frequency bars mirrored around the center.'},
    {id:'spectrogram',label:'Spectrogram',description:'A scrolling history of the music frequencies.'},
    {id:'audio-particles',label:'Audio particles',description:'Drifting particles energized by the music.'},
    {id:'radial-tunnel',label:'Radial tunnel',description:'A pulsing tunnel of concentric geometric rings.'},
    {id:'xy-scope',label:'XY scope',description:'Geometric figures from the waveform and a delayed copy.'},
    {id:'plasma',label:'Plasma',description:'Smooth color fields shaped by the music.'}
  ].map(value => Object.freeze(value)));
  const clamp = value => Math.max(0,Math.min(1,value));
  function create(id,options = {}) {
    if (!presets.some(preset => preset.id === id)) return null;
    const peaks = new Float32Array(40);
    const history = new Float32Array(48 * 24);
    const document = options.document || root.document;
    const plasmaCanvas = id === 'plasma' ? document?.createElement?.('canvas') : null;
    let plasmaContext = null;
    if (plasmaCanvas) { plasmaCanvas.width = 32; plasmaCanvas.height = 18; plasmaContext = plasmaCanvas.getContext?.('2d'); }
    let phase = 0, historyHead = 0;
    function reset() { peaks.fill(0); history.fill(0); phase = 0; historyHead = 0; }
    function draw(context,frame) {
      const {width,height,levels,samples,active,intensity} = frame;
      const seconds = Math.max(0,Math.min(.25,frame.elapsed / 1000 || 0));
      const energy = active ? levels.reduce((sum,value) => sum + value,0) / levels.length : 0;
      if (active) phase = (phase + seconds * energy * 1.8) % (Math.PI * 2);
      const transparent = ['mirror-spectrum','audio-particles','xy-scope'].includes(id);
      context.globalAlpha = 1;
      if (!transparent) { context.fillStyle = '#080d18'; context.fillRect(0,0,width,height); }
      const trace = (points,color,lineWidth,alpha = 1) => {
        context.globalAlpha = alpha; context.strokeStyle = color; context.lineWidth = lineWidth;
        context.beginPath();
        points.forEach(([x,y],index) => {
          x = Math.max(0,Math.min(width,x)); y = Math.max(0,Math.min(height,y));
          index ? context.lineTo(x,y) : context.moveTo(x,y);
        });
        context.stroke();
      };
      const sample = index => active ? Math.max(-1,Math.min(1,(samples[index] - 128) / 128 * intensity / 60)) : 0;
      if (id === 'classic-bars') {
        const columns = 40, rows = 28, margin = 24, step = (width - margin * 2) / columns;
        const unit = (height - margin * 2) / rows;
        for (let i = 0; i < columns; i++) {
          const value = active ? clamp(levels[i]) : 0;
          peaks[i] = Math.max(value,peaks[i] - seconds * .34);
          for (let row = 0; row < rows; row++) {
            context.globalAlpha = row < Math.round(value * rows) ? 1 : .09;
            context.fillStyle = row > rows * .82 ? '#ff6a70' : row > rows * .58 ? '#ffd56b' : '#6be79a';
            context.fillRect(margin + i * step,height - margin - (row + 1) * unit,step * .72,Math.max(1,unit - 3));
          }
          if (peaks[i] > 0) {
            context.globalAlpha = .95; context.fillStyle = '#e3fff0';
            context.fillRect(margin + i * step,height - margin - peaks[i] * rows * unit,step * .72,2);
          }
        }
      } else if (id === 'neon-scope') {
        for (let x = 24; x < width; x += 48) trace([[x,16],[x,height - 16]],'#223149',1,.45);
        for (let y = 36; y < height; y += 36) trace([[16,y],[width - 16,y]],'#223149',1,.45);
        const points = Array.from(samples,(_,i) => [16 + i / (samples.length - 1) * (width - 32),height / 2 + sample(i) * height * .36]);
        trace(points,'#267aa3',13,.12); trace(points,'#48cfff',7,.25); trace(points,'#b0ffde',2,active ? 1 : .35);
      } else if (id === 'ribbon-waves') {
        const colors = ['#5067e8','#8c6aee','#dd82e9','#63d9ed','#b2f6f0'];
        for (let layer = 0; layer < colors.length; layer++) {
          const points = [];
          for (let i = 0; i <= 128; i++) {
            const fraction = i / 128, envelope = Math.sin(fraction * Math.PI);
            const wave = sample(Math.min(samples.length - 1,i * 2)) * .23;
            const drift = Math.sin(fraction * Math.PI * 4 + phase + layer * .6) * energy * .23;
            points.push([fraction * width,height / 2 + (wave + drift) * envelope * height + (layer - 2) * (5 + energy * 8)]);
          }
          trace(points,colors[layer],14 - layer * 2,.06 + energy * .12);
          trace(points,colors[layer],2,active ? .65 : .2);
        }
      } else if (id === 'radial-bloom') {
        const centerX = width / 2, centerY = height / 2, radius = Math.min(width,height) * .23;
        for (let ring = 0; ring < 3; ring++) {
          const points = [];
          for (let i = 0; i <= 96; i++) {
            const angle = i / 96 * Math.PI * 2;
            const ripple = Math.sin(angle * 6 + phase + ring) * energy * 12;
            const distance = radius + ring * 12 + ripple;
            points.push([centerX + Math.cos(angle) * distance,centerY + Math.sin(angle) * distance]);
          }
          trace(points,['#6ee8ff','#a592ff','#ef9cdd'][ring],2,active ? .6 : .15);
        }
        for (let i = 0; i < 80; i++) {
          const angle = i / 80 * Math.PI * 2 - Math.PI / 2;
          const band = i < 40 ? i : 79 - i;
          const length = 2 + (active ? clamp(levels[band]) : 0) * Math.min(width,height) * .19;
          trace([[centerX + Math.cos(angle) * (radius + 30),centerY + Math.sin(angle) * (radius + 30)],
            [centerX + Math.cos(angle) * (radius + 30 + length),centerY + Math.sin(angle) * (radius + 30 + length)]],
          i < 40 ? '#78e7ef' : '#c3a0fa',3,active ? .9 : .16);
        }
      } else if (id === 'mirror-spectrum') {
        const step = width / 80;
        for (let i=0; i<80; i++) {
          const level = active ? clamp(levels[i < 40 ? i : 79 - i]) : 0;
          const size = 2 + level * height * .43;
          context.fillStyle = i % 2 ? '#9c78d2' : frame.color || '#73e4cf'; context.globalAlpha = active ? .85 : .2;
          context.fillRect(i * step + step * .15,height / 2 - size,step * .7,size * 2);
        }
      } else if (id === 'spectrogram') {
        if (active) {
          for (let band=0; band<24; band++) history[historyHead * 24 + band] = clamp(levels[Math.floor(band * levels.length / 24)]);
          historyHead = (historyHead + 1) % 48;
        }
        const dx = width / 48, dy = height / 24;
        for (let x=0; x<48; x++) for (let y=0; y<24; y++) {
          const value = history[((historyHead + x) % 48) * 24 + y];
          context.globalAlpha = .08 + value * .92;
          context.fillStyle = `hsl(${255 - value * 210} 90% ${20 + value * 45}%)`;
          context.fillRect(x * dx,height - (y + 1) * dy,dx + .5,dy + .5);
        }
      } else if (id === 'audio-particles') {
        for (let i=0; i<112; i++) {
          const band = levels[i % levels.length] || 0;
          const x = ((i * .6180339 + Math.sin(phase + i) * energy * .06) % 1 + 1) % 1;
          const y = ((i * .4142135 - phase * .06 + Math.cos(i + phase) * energy * .05) % 1 + 1) % 1;
          const size = 1 + (active ? band : 0) * 5;
          context.fillStyle = i % 3 ? frame.color || '#81e8d1' : '#a876d8'; context.globalAlpha = active ? .25 + band * .65 : .12;
          context.fillRect(x * Math.max(0,width - size),y * Math.max(0,height - size),size,size);
        }
      } else if (id === 'radial-tunnel') {
        const radius = Math.min(width,height) * .47;
        for (let ring=0; ring<12; ring++) {
          const distance = ((ring / 12 + phase * .08) % 1) * radius;
          const points = [];
          for (let i=0; i<=64; i++) {
            const angle = i / 64 * Math.PI * 2 + phase * .08;
            const ripple = 1 + (active ? levels[i % levels.length] : 0) * .05;
            points.push([width / 2 + Math.cos(angle) * distance * ripple,height / 2 + Math.sin(angle) * distance * ripple]);
          }
          trace(points,ring % 2 ? '#a793f5' : '#5edbd3',1 + energy * 2,active ? .15 + distance / radius * .75 : .12);
        }
      } else if (id === 'xy-scope') {
        const points = [];
        for (let i=0; i<samples.length; i++) {
          points.push([width / 2 + sample(i) * width * .25,
            height / 2 + sample((i + 37) % samples.length) * height * .25]);
        }
        trace(points,'#9c82ff',9,.12); trace(points,frame.color || '#8aefd5',2,active ? .9 : .2);
      } else if (id === 'plasma') {
        const target = plasmaContext || context;
        const dx = width / 32, dy = height / 18;
        for (let x=0; x<32; x++) for (let y=0; y<18; y++) {
          const field = (Math.sin(x * .25 + phase) + Math.cos(y * .3 - phase * .8) + Math.sin((x + y) * .18 + phase * .4)) / 3;
          target.globalAlpha = 1;
          target.fillStyle = `hsl(${230 + field * 70 + energy * 40} 70% ${18 + (field + 1) * 12 + energy * 12}%)`;
          target.fillRect(plasmaContext ? x : x * dx,plasmaContext ? y : y * dy,plasmaContext ? 1 : dx + 1,plasmaContext ? 1 : dy + 1);
        }
        if (plasmaContext) {
          context.globalAlpha = active ? .9 : .25; context.imageSmoothingEnabled = true;
          context.drawImage(plasmaCanvas,0,0,width,height);
        }
      }
      context.globalAlpha = 1;
    }
    return {draw,reset};
  }
  const api = Object.freeze({presets,create});
  root.MusicVisualizationPresets = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
