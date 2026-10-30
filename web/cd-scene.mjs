/* GPU-only presentation. Loaded lazily, with a pinned local Three.js build. */
import * as THREE from './vendor/three-r180/three.module.min.js';

export function createCDScene(canvas, context, options = {}) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  let renderer, environment, disposed = false, imageGeneration = 0, pendingImage = null, coverImage = null;
  let artwork = null, coverTexture = null, defaultTexture = null, paletteKey = '', lastPose = '';
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(38,1,.1,50);
  const assembly = new THREE.Group(); assembly.name = 'cd-case'; scene.add(assembly);
  const lid = new THREE.Group(); lid.name = 'case-lid'; lid.position.set(-1.46,0,.06); assembly.add(lid);
  const disc = new THREE.Group(); disc.name = 'disc'; disc.position.set(.12,0,.16); assembly.add(disc);
  const artMaterials = [];
  const fitPoints = [], bounds = new THREE.Box3(), center = new THREE.Vector3();
  for (const x of [-1.52,1.52]) for (const y of [-1.3,1.3]) for (const z of [-.12,.24]) fitPoints.push({point:new THREE.Vector3(x,y,z),object:assembly,world:new THREE.Vector3()});
  for (const x of [0,2.92]) for (const y of [-1.3,1.3]) for (const z of [-.03,.14]) fitPoints.push({point:new THREE.Vector3(x,y,z),object:lid,world:new THREE.Vector3()});
  const geometry = value => { geometries.add(value); return value; };
  const material = value => { materials.add(value); return value; };
  function mesh(parent, shape, surface, name, x=0, y=0, z=0) {
    const value = new THREE.Mesh(geometry(shape),surface); value.name = name; value.position.set(x,y,z);
    value.castShadow = true; parent.add(value); return value;
  }
  function box(parent, size, surface, name, x=0,y=0,z=0) {
    return mesh(parent,new THREE.BoxGeometry(...size),surface,name,x,y,z);
  }
  function detachImage(image) { if (image) { image.onload = null; image.onerror = null; image.removeAttribute('src'); } }
  function releaseTexture(texture) { if (texture) { texture.dispose(); textures.delete(texture); } }
  function applyTexture(texture) {
    for (const value of artMaterials) if (value.map !== texture) { value.map = texture; value.needsUpdate = true; }
  }
  function proceduralArtwork(accent) {
    const color = new THREE.Color(accent), data = new Uint8Array(64 * 64 * 4);
    for (let y=0; y<64; y++) for (let x=0; x<64; x++) {
      const index = (y * 64 + x) * 4;
      const light = .3 + .55 * ((x + y) / 126), stripe = Math.floor((x + y) / 12) % 2 ? .1 : 0;
      data[index] = Math.min(255,(color.r * .65 + light * .35 + stripe) * 255);
      data[index+1] = Math.min(255,(color.g * .65 + light * .35 + stripe) * 255);
      data[index+2] = Math.min(255,(color.b * .65 + light * .35 + stripe) * 255); data[index+3] = 255;
    }
    const texture = new THREE.DataTexture(data,64,64,THREE.RGBAFormat);
    texture.colorSpace = THREE.SRGBColorSpace; texture.needsUpdate = true; textures.add(texture); return texture;
  }
  function makeEnvironment() {
    const room = new THREE.Scene(), temporaryGeometry = [], temporaryMaterial = [];
    const add = (shape, surface, x,y,z) => {
      temporaryGeometry.push(shape); temporaryMaterial.push(surface);
      const value = new THREE.Mesh(shape,surface); value.position.set(x,y,z); value.lookAt(0,0,0); room.add(value);
    };
    add(new THREE.BoxGeometry(12,12,12),new THREE.MeshBasicMaterial({color:0x777d89,side:THREE.BackSide}),0,0,0);
    for (const [x,y,z,w,h] of [[-4,2,3,3,5],[4,3,1,2,4],[0,5,-2,5,3]]) {
      add(new THREE.PlaneGeometry(w,h),new THREE.MeshBasicMaterial({color:new THREE.Color().setRGB(4,4,4)}),x,y,z);
    }
    const generator = new THREE.PMREMGenerator(renderer);
    try { environment = generator.fromScene(room,.03,.1,30,{size:128}); scene.environment = environment.texture; }
    finally { generator.dispose(); temporaryGeometry.forEach(value => value.dispose()); temporaryMaterial.forEach(value => value.dispose()); }
  }
  let glass, liner;
  function setPalette(value) {
    if (disposed) return;
    const palette = {surface:value?.surface || '#ffffff',accent:value?.accent || '#24754b'};
    const key = JSON.stringify(palette); if (key === paletteKey) return; paletteKey = key;
    glass.color.set(palette.surface).lerp(new THREE.Color(0xffffff),.92);
    liner.color.set(palette.surface).lerp(new THREE.Color(0x59616e),.2);
    const previous = defaultTexture; defaultTexture = proceduralArtwork(palette.accent);
    if (!coverTexture) applyTexture(defaultTexture);
    releaseTexture(previous);
  }
  function setArtwork(value) {
    if (disposed) return;
    const url = /^\/covers\/[a-f0-9]{64}\.jpg$/.test(value || '') ? value : '';
    if (url === artwork) return;
    artwork = url; const generation = ++imageGeneration;
    detachImage(pendingImage); pendingImage = null; detachImage(coverImage); coverImage = null;
    applyTexture(defaultTexture); releaseTexture(coverTexture); coverTexture = null;
    if (!url) { options.onArtwork?.('empty'); options.onInvalidate?.(); return; }
    const image = options.createImage ? options.createImage() : document.createElement('img');
    pendingImage = image; image.decoding = 'async'; options.onArtwork?.('loading');
    const relevant = () => !disposed && generation === imageGeneration && pendingImage === image;
    image.onload = () => {
      if (!relevant()) return;
      if (!(image.naturalWidth > 0 && image.naturalHeight > 0)) { image.onerror(); return; }
      try {
        const texture = new THREE.Texture(image); texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = Math.min(4,renderer.capabilities.getMaxAnisotropy()); texture.needsUpdate = true;
        textures.add(texture); coverTexture = texture; coverImage = image; pendingImage = null;
        image.onload = null; image.onerror = null; applyTexture(texture);
        options.onArtwork?.('ready'); options.onInvalidate?.();
      } catch { pendingImage = null; detachImage(image); options.onArtwork?.('failed'); options.onInvalidate?.(); }
    };
    image.onerror = () => {
      if (!relevant()) return;
      pendingImage = null; detachImage(image); options.onArtwork?.('failed'); options.onInvalidate?.();
    };
    image.src = url;
  }
  function resize(width,height) {
    if (disposed) return;
    const scale = Math.min(1,1000 / Math.max(1,width),540 / Math.max(1,height));
    width = Math.max(1,Math.round(width * scale)); height = Math.max(1,Math.round(height * scale));
    renderer.setSize(width,height,false); camera.aspect = width / height;
    camera.updateProjectionMatrix(); lastPose = ''; renderer.shadowMap.needsUpdate = true;
  }
  function render(pose) {
    if (disposed) return;
    lid.rotation.y = pose.lid; disc.rotation.z = pose.spin;
    assembly.rotation.set(pose.pitch,pose.yaw,0);
    const next = [pose.lid,pose.pitch,pose.yaw].join(',');
    if (next !== lastPose) {
      assembly.updateMatrixWorld(true); bounds.makeEmpty();
      for (const value of fitPoints) { value.world.copy(value.point).applyMatrix4(value.object.matrixWorld); bounds.expandByPoint(value.world); }
      bounds.getCenter(center);
      const tangent = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      let distance = center.z + 3.8;
      for (const value of fitPoints) distance = Math.max(distance,value.world.z + Math.abs(value.world.x - center.x) * 1.15 / (tangent * camera.aspect),value.world.z + Math.abs(value.world.y - center.y) * 1.15 / tangent);
      camera.position.set(center.x,center.y,distance); camera.lookAt(center); camera.updateMatrixWorld();
      renderer.shadowMap.needsUpdate = true; lastPose = next;
    }
    renderer.render(scene,camera);
  }
  function dispose() {
    if (disposed) return;
    disposed = true; imageGeneration++; detachImage(pendingImage); detachImage(coverImage);
    pendingImage = coverImage = null;
    geometries.forEach(value => value.dispose()); materials.forEach(value => value.dispose()); textures.forEach(value => value.dispose());
    geometries.clear(); materials.clear(); textures.clear(); environment?.dispose();
    renderer?.dispose(); renderer?.forceContextLoss();
  }
  try {
    renderer = options.rendererFactory ? options.rendererFactory(canvas,context) : new THREE.WebGLRenderer({canvas,context,alpha:true,antialias:false,powerPreference:'low-power'});
    renderer.setPixelRatio(Math.min(1.25,options.pixelRatio || 1)); renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15;
    renderer.transmissionResolutionScale = .5;
    renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.shadowMap.autoUpdate = false;
    renderer.debug.onShaderError = () => { throw Error('CD shader compilation failed'); };
    glass = material(new THREE.MeshPhysicalMaterial({color:0xffffff,roughness:.12,metalness:0,transmission:.92,thickness:.035,ior:1.49,envMapIntensity:1.6}));
    liner = material(new THREE.MeshStandardMaterial({color:0xd3d7df,roughness:.65,metalness:.15}));
    const black = material(new THREE.MeshStandardMaterial({color:0x343b46,roughness:.45}));
    const silver = material(new THREE.MeshPhysicalMaterial({color:0xdde2ed,metalness:.9,roughness:.22,iridescence:.85,iridescenceThicknessRange:[100,400]}));
    const paper = material(new THREE.MeshStandardMaterial({color:0xffffff,roughness:.8,side:THREE.DoubleSide}));
    const print = material(new THREE.MeshStandardMaterial({color:0xffffff,roughness:.6,metalness:.08,side:THREE.DoubleSide}));
    artMaterials.push(paper,print);
    box(assembly,[2.9,2.56,.12],glass,'case-base',0,0,-.06);
    box(assembly,[2.63,2.42,.035],liner,'disc-tray',.115,0,.02);
    box(assembly,[.22,2.54,.18],glass,'case-spine',-1.34,0,.025);
    for (const y of [-1.26,1.26]) box(assembly,[2.9,.035,.22],glass,'case-edge',0,y,.015);
    for (const x of [-1.43,1.43]) box(assembly,[.035,2.5,.22],glass,'case-edge',x,0,.015);
    box(lid,[2.9,2.56,.045],glass,'clear-lid',1.46,0,.09);
    mesh(lid,new THREE.PlaneGeometry(2.36,2.36),paper,'album-insert',1.58,0,.116);
    for (const y of [-1.24,1.24]) box(lid,[2.9,.035,.13],glass,'lid-edge',1.46,y,.045);
    for (const x of [.02,2.9]) box(lid,[.035,2.5,.13],glass,'lid-edge',x,0,.045);
    const hinge = mesh(assembly,new THREE.CylinderGeometry(.038,.038,2.35,16),glass,'hinge',-1.46,0,.06);
    hinge.castShadow = false;
    mesh(disc,new THREE.RingGeometry(.18,1.12,96),silver,'disc-surface');
    mesh(disc,new THREE.RingGeometry(.24,1.035,96),print,'disc-label',0,0,.008);
    mesh(disc,new THREE.TorusGeometry(1.115,.012,6,96),silver,'disc-rim');
    mesh(disc,new THREE.RingGeometry(.15,.225,48),silver,'disc-hub-ring',0,0,.012);
    const hub = mesh(assembly,new THREE.CylinderGeometry(.13,.16,.1,24),black,'disc-holder',.12,0,.12); hub.rotation.x = Math.PI / 2;
    for (let i=0; i<12; i++) {
      const angle = i / 12 * Math.PI * 2;
      const clip = box(assembly,[.025,.11,.055],black,'hub-clip',.12 + Math.cos(angle) * .12,Math.sin(angle) * .12,.175);
      clip.rotation.z = angle - Math.PI / 2;
    }
    scene.add(new THREE.HemisphereLight(0xffffff,0x637083,2));
    const light = new THREE.DirectionalLight(0xffffff,3.5); light.position.set(-3,5,6); light.castShadow = true;
    light.shadow.mapSize.set(512,512); Object.assign(light.shadow.camera,{left:-5,right:5,top:5,bottom:-5,near:.5,far:20});
    light.shadow.bias = -.002; scene.add(light);
    const rim = new THREE.DirectionalLight(0xc9ddff,1.5); rim.position.set(4,1,-3); scene.add(rim);
    const floor = mesh(scene,new THREE.PlaneGeometry(20,12),material(new THREE.ShadowMaterial({opacity:.18})),'floor',0,-1.44,0);
    floor.rotation.x = -Math.PI / 2; floor.castShadow = false; floor.receiveShadow = true;
    if (options.environment !== false) makeEnvironment();
    setPalette(options.palette); resize(800,360);
    return {setPalette,setArtwork,resize,render,dispose};
  } catch (error) { dispose(); throw error; }
}
