/* Bounded Canvas renderers. Input is sampled data, never playback state or audio. */
(function(root) {
  const presets = Object.freeze([
    {id:'classic-bars',label:'Classic bars',description:'Segmented spectrum with falling peaks, inspired by Winamp.'},
    {id:'neon-scope',label:'Neon scope',description:'Glowing oscilloscope on a dark grid, inspired by Winamp.'},
    {id:'ribbon-waves',label:'Ribbon waves',description:'Flowing audio ribbons, inspired by Windows Media Player.'},
    {id:'radial-bloom',label:'Radial bloom',description:'Circular spectrum and light rings, inspired by Windows Media Player.'}
  ].map(value => Object.freeze(value)));
  const clamp = value => Math.max(0,Math.min(1,value));
  function create(id) {
    if (!presets.some(preset => preset.id === id)) return null;
    const peaks = new Float32Array(40);
    let phase = 0;
    function reset() { peaks.fill(0); phase = 0; }
    function draw(context,frame) {
      const {width,height,levels,samples,active,intensity} = frame;
      const seconds = Math.max(0,Math.min(.25,frame.elapsed / 1000 || 0));
      const energy = active ? levels.reduce((sum,value) => sum + value,0) / levels.length : 0;
      if (active) phase = (phase + seconds * energy * 1.8) % (Math.PI * 2);
      context.globalAlpha = 1; context.fillStyle = '#080d18'; context.fillRect(0,0,width,height);
      const trace = (points,color,lineWidth,alpha = 1) => {
        context.globalAlpha = alpha; context.strokeStyle = color; context.lineWidth = lineWidth;
        context.beginPath();
        points.forEach(([x,y],index) => index ? context.lineTo(x,y) : context.moveTo(x,y));
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
      } else {
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
      }
      context.globalAlpha = 1;
    }
    return {draw,reset};
  }
  const api = Object.freeze({presets,create});
  root.MusicVisualizationPresets = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
