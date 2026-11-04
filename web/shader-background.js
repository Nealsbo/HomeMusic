/* Independent presentation surface. No audio access or external dependencies. */
(function(root) {
  const vertex = `
    attribute vec2 position;
    varying vec2 uv;
    void main() { uv = position * .5 + .5; gl_Position = vec4(position,0.,1.); }
  `;
  const header = `
    precision mediump float;
    varying vec2 uv;
    uniform float time;
    uniform float aspect;
    uniform vec2 resolution;
    uniform vec3 primary;
    uniform vec3 secondary;
    float hash(vec2 p) { return fract(sin(dot(p,vec2(127.1,311.7))) * 43758.5453); }
    float noise(vec2 p) {
      vec2 i = floor(p), f = fract(p); f = f*f*(3.-2.*f);
      return mix(mix(hash(i),hash(i+vec2(1,0)),f.x),
                 mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x),f.y);
    }
  `;
  const fragments = Object.freeze({
    aurora: header + `
    void main() {
      vec2 p = vec2((uv.x-.5)*min(aspect,2.4),uv.y);
      float t = time*.075;
      vec3 light = mix(primary,secondary,uv.y)*.035;
      // Broad, soft ribbons with gently changing curves; no fine filaments.
      for (int i=0;i<3;i++) {
        float layer = float(i);
        float phase = t*(.7+layer*.15)+layer*2.1;
        float center = .25+layer*.24+p.x*.14
                     + sin(p.x*2.2+phase)*.11;
        float width = .10+.035*sin(p.x*1.4-phase*.65+layer);
        float distance = (p.y-center)/width;
        float ribbon = exp(-distance*distance*1.6);
        float glow = exp(-distance*distance*.3)*.18;
        vec3 tint = mix(primary,secondary,layer*.5);
        light += tint*(ribbon+glow)*(.65+.12*sin(phase+p.x));
      }
      gl_FragColor = vec4(1.-exp(-light*1.1),1.);
    }
  `,
    'northern-lights': header + `
    void main() {
      vec3 light = vec3(0.);
      float t = time * .12;
      // Each curtain has its own evolving lower edge and vertical filaments.
      for (int i=0; i<3; i++) {
        float layer = float(i), seed = layer * 7.31;
        float x = (uv.x-.5) * min(aspect,2.4) + .5;
        float warp = noise(vec2(x*2.2+seed,t*.32))-.5;
        float fold = sin(x*5.5 + seed + t*.6 + warp*3.);
        float edge = .24 + layer*.115 + fold*.075
                   + (noise(vec2(x*5.+seed,t*.5))-.5)*.12;
        float height = .18 + noise(vec2(x*3.+seed,t*.3+8.))*.24;
        float above = uv.y-edge;
        float ribbon = exp(-abs(above)*75.);
        float veil = smoothstep(-.015,.025,above) * exp(-max(above,0.)/height*3.);
        float filament = noise(vec2(x*95.+warp*12.+seed,t*.65));
        filament = .22 + .78*filament*filament;
        float folds = .35 + .65*pow(.5+.5*sin(x*22.+warp*9.+seed+t*.35),2.);
        float energy = .55 + .45*noise(vec2(x*4.+seed,t*.55));
        vec3 tint = mix(primary,secondary,clamp(above/height+layer*.2,0.,1.));
        light += tint * (veil*filament*folds*1.65 + ribbon*.26) * energy;
      }
      float vignette = smoothstep(0.,.18,uv.x)*smoothstep(0.,.18,1.-uv.x);
      light *= mix(.25,1.,vignette) * smoothstep(0.,.12,1.-uv.y);
      gl_FragColor = vec4(1.-exp(-light*1.6),1.);
    }
  `,
    gradient: header + `
    void main() {
      vec2 p = vec2((uv.x-.5)*aspect,uv.y-.5);
      float t = time*.055;
      vec2 flow = vec2(noise(p*1.8+vec2(t,t*.4)),noise(p*1.7+vec2(7.-t*.6,t)));
      float field = noise(p*1.6+flow*2.+vec2(t*.2,-t*.3));
      float detail = noise(p*3.1-flow+vec2(-t*.5,9.));
      float blend = smoothstep(.2,.8,field*.75+detail*.25);
      float glow = .28+.65*smoothstep(.12,.85,noise(p*1.4+flow+vec2(t*.3,4.)));
      vec3 color = mix(primary,secondary,blend)*glow;
      color += mix(primary,secondary,1.-blend)*pow(field,4.)*.22;
      gl_FragColor = vec4(color,1.);
    }
  `,
    stars: header + `
    void main() {
      vec2 p = vec2((uv.x-.5)*aspect,uv.y-.5);
      vec3 color = mix(primary,secondary,uv.y)*.025;
      // Three independently seeded depth planes. Stars are random per cell,
      // with slow travel and continuous, unsynchronized brightness changes.
      for (int i=0;i<3;i++) {
        float layer = float(i), depth = 1.+layer*.65;
        vec2 world = p*(27.-layer*6.) + vec2(time*.025*depth,time*.012*depth);
        vec2 cell = floor(world), local = fract(world);
        vec2 seed = cell+layer*73.9;
        float chance = hash(seed);
        vec2 center = .15+.7*vec2(hash(seed+vec2(21,7)),hash(seed+vec2(3,53)));
        float radius = (.55+hash(seed+vec2(5,17))*.65)*depth*(27.-layer*6.)/resolution.y;
        float distance = length(local-center);
        float star = 1.-smoothstep(radius*.25,radius*1.6,distance);
        float halo = exp(-distance/max(radius*2.,.001))*.12;
        float twinkle = .65+.35*sin(time*(.35+chance*.6)+chance*63.);
        vec3 tint = mix(mix(primary,secondary,chance),vec3(1.),.65);
        color += tint*(star+halo)*twinkle*step(.78,chance);
      }
      gl_FragColor = vec4(color,1.);
    }
  `,
    grid: header + `
    float line(float coordinate,float width) {
      float distance = abs(fract(coordinate-.5)-.5);
      return 1.-smoothstep(width,width*2.2,distance);
    }
    void main() {
      vec2 p = vec2((uv.x-.5)*aspect,uv.y);
      vec3 pink = mix(vec3(1.,.035,.52),secondary,.28);
      vec3 blue = mix(vec3(.03,.7,1.),primary,.4);
      float horizon = .4;
      float down = horizon-p.y;
      float depth = 1./max(down,.018);
      float travel = time*.38;
      vec2 plane = vec2(p.x*depth*1.8,depth*.85+travel);
      // Estimate each projected pixel footprint. Fade the distant floor before
      // its cells become subpixel, avoiding a dotted/shimmering horizon.
      float pixelX = (1.8*depth+abs(p.x)*1.8*depth*depth)/resolution.y;
      float pixelY = .85*depth*depth/resolution.y;
      float mesh = max(line(plane.x,clamp(pixelX,.012,.22)),line(plane.y,clamp(pixelY,.012,.22)));
      float fade = smoothstep(.10,.28,down)*(1.-smoothstep(.15,.5,pixelY));
      vec3 sky = mix(vec3(.012,.009,.045),pink*.16,exp(-abs(down)*7.));
      float wide = smoothstep(.9,1.7,aspect);
      float sunX = mix(.82,.74,wide);
      float radius = min(mix(.115,.18,wide),aspect*.23);
      // Lift the portrait sun above the central artwork instead of hiding it.
      float sunY = mix(.86,horizon+radius*.92,wide);
      vec2 sunPoint = vec2((uv.x-sunX)*aspect,uv.y-sunY);
      float distance = length(sunPoint);
      float pixel = 1.5/resolution.y;
      float disc = 1.-smoothstep(radius-pixel,radius+pixel,distance);
      float sunHeight = (sunPoint.y/radius+1.)*.5;
      // Horizontal cuts widen down the sunset disc, leaving the top whole.
      float stripePhase = fract(sunHeight*9.);
      float gap = mix(.54,.04,smoothstep(0.,.85,sunHeight));
      float bands = smoothstep(gap,gap+.035,stripePhase);
      bands = mix(bands,1.,smoothstep(.72,.8,sunHeight));
      vec3 sunset = mix(vec3(1.,.08,.37),vec3(1.,.75,.12),clamp(sunHeight,0.,1.));
      sky += sunset*disc*bands*1.15;
      sky += pink*exp(-max(distance-radius,0.)*12.)*.15;
      // A low, angular silhouette keeps the horizon from being a hard seam.
      float hills = horizon+.014+noise(vec2(uv.x*18.,3.))*.035;
      sky *= smoothstep(hills-.002,hills+.003,uv.y);
      vec3 floorColor = vec3(.009,.004,.024);
      floorColor += pink*mesh*fade*.8;
      float road = exp(-abs(abs(plane.x)-1.8)/max(pixelX*1.2,.015));
      floorColor += blue*road*fade*.8;
      floorColor += pink*exp(-abs(down)*18.)*.15;
      float reflection = exp(-abs((uv.x-sunX)*aspect)*7.)*exp(-down*8.);
      floorColor += vec3(1.,.12,.32)*reflection*.07;
      vec3 color = mix(floorColor,sky,smoothstep(-pixel,pixel,-down));
      gl_FragColor = vec4(1.-exp(-color*1.35),1.);
    }
  `});
  const rgb = hex => [1,3,5].map(offset => parseInt(hex.slice(offset,offset+2),16)/255);
  class PlayerBackground {
    constructor(host, options = {}) {
      this.host = host;
      this.env = options.env || root;
      this.canvas = this.env.document.createElement('canvas');
      this.canvas.className = 'player-shader-background';
      this.canvas.setAttribute('aria-hidden','true');
      this.time = 0; this.timer = null; this.lastTime = null; this.disposed = false;
      this.onLost = event => {
        event.preventDefault(); this.stop(); this.ready = false;
        // Context loss already destroys GPU objects; their handles cannot be
        // deleted in the restored context.
        this.buffer = this.program = null; this.shaders = [];
        this.canvas.hidden = true;
        this.host.dataset.backgroundRenderer = 'fallback';
      };
      this.onRestored = () => {
        if (this.disposed) return;
        this.initialize(); this.refresh();
      };
      this.canvas.addEventListener('webglcontextlost',this.onLost);
      this.canvas.addEventListener('webglcontextrestored',this.onRestored);
      this.onResize = () => { if (this.config?.visible) this.refresh(); };
      if (this.env.ResizeObserver) {
        this.observer = new this.env.ResizeObserver(this.onResize); this.observer.observe(host);
      } else this.env.addEventListener?.('resize',this.onResize);
    }
    initialize() {
      try {
        const gl = this.gl = this.canvas.getContext('webgl',{
          alpha:false,antialias:false,depth:false,stencil:false,preserveDrawingBuffer:false,powerPreference:'low-power'
        });
        if (!gl) throw new Error('WebGL unavailable');
        this.shaders = [];
        const compile = (type,source) => {
          const shader = gl.createShader(type); this.shaders.push(shader);
          gl.shaderSource(shader,source); gl.compileShader(shader);
          if (!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw new Error('Shader compilation failed');
          return shader;
        };
        this.program = gl.createProgram();
        gl.attachShader(this.program,compile(gl.VERTEX_SHADER,vertex));
        gl.attachShader(this.program,compile(gl.FRAGMENT_SHADER,fragments[this.config.background]));
        gl.linkProgram(this.program);
        if (!gl.getProgramParameter(this.program,gl.LINK_STATUS)) throw new Error('Shader linking failed');
        gl.useProgram(this.program);
        this.buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,this.buffer);
        gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
        const position = gl.getAttribLocation(this.program,'position');
        gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
        this.uniforms = Object.fromEntries(['time','aspect','resolution','primary','secondary'].map(name => [name,gl.getUniformLocation(this.program,name)]));
        this.ready = true;
      } catch {
        this.ready = false; this.release();
      }
      this.host.dataset.backgroundRenderer = this.ready ? 'webgl' : 'fallback';
    }
    update(config) {
      if (this.disposed) return;
      const previous = this.config;
      // Account for elapsed time at the old speed before applying a new one.
      this.advance();
      this.config = {...config};
      if (!previous || config.background !== previous.background) {
        this.stop(); this.release(); this.initialize();
      }
      this.canvas.hidden = !config.visible || !this.ready;
      if (config.visible && this.canvas.parentNode !== this.host) this.host.append(this.canvas);
      if (!previous || Object.keys(config).some(key => config[key] !== previous[key])) this.refresh();
    }
    advance() {
      if (this.lastTime === null) return;
      const now = this.env.performance.now();
      this.time += Math.max(0,now-this.lastTime)/1000 * this.config.speed/20;
      this.lastTime = now;
    }
    stop() {
      this.advance();
      if (this.timer !== null) this.env.clearTimeout(this.timer);
      this.timer = null; this.lastTime = null;
    }
    refresh() {
      this.stop();
      this.canvas.hidden = !this.ready || !this.config?.visible;
      if (!this.ready || !this.config?.visible || this.disposed) return;
      this.draw();
      if (this.config.moving && this.config.speed > 0) {
        this.lastTime = this.env.performance.now(); this.schedule();
      }
    }
    schedule() {
      // A delay after each draw also bounds frame rate on slow GPUs.
      this.timer = this.env.setTimeout(() => {
        this.timer = null; this.advance(); this.draw(); this.schedule();
      },Math.ceil(1000/30));
    }
    draw() {
      const rect = this.host.getBoundingClientRect();
      const scale = Math.min(.65,960/Math.max(1,rect.width),540/Math.max(1,rect.height));
      const width = Math.max(1,Math.round(rect.width*scale)), height = Math.max(1,Math.round(rect.height*scale));
      if (this.canvas.width !== width) this.canvas.width = width;
      if (this.canvas.height !== height) this.canvas.height = height;
      const gl = this.gl, u = this.uniforms;
      gl.viewport(0,0,width,height); gl.useProgram(this.program);
      gl.uniform1f(u.time,this.time); gl.uniform1f(u.aspect,width/height);
      gl.uniform2f(u.resolution,width,height);
      gl.uniform3fv(u.primary,rgb(this.config.primary)); gl.uniform3fv(u.secondary,rgb(this.config.secondary));
      gl.drawArrays(gl.TRIANGLES,0,6);
    }
    release() {
      if (!this.gl) return;
      if (this.buffer) this.gl.deleteBuffer(this.buffer);
      if (this.program) this.gl.deleteProgram(this.program);
      for (const shader of this.shaders || []) this.gl.deleteShader(shader);
      this.buffer = this.program = null; this.shaders = [];
    }
    dispose() {
      if (this.disposed) return;
      this.stop(); this.disposed = true; this.observer?.disconnect();
      this.env.removeEventListener?.('resize',this.onResize);
      this.canvas.removeEventListener('webglcontextlost',this.onLost);
      this.canvas.removeEventListener('webglcontextrestored',this.onRestored);
      this.release();
      this.gl?.getExtension('WEBGL_lose_context')?.loseContext();
      this.canvas.remove(); delete this.host.dataset.backgroundRenderer;
    }
  }
  PlayerBackground.supports = background => Object.hasOwn(fragments,background);
  root.PlayerBackground = PlayerBackground;
  if (typeof module !== 'undefined' && module.exports) module.exports = {PlayerBackground};
})(globalThis);
