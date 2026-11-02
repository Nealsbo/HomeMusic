const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');

async function fixture() {
  const {createCDScene} = await import('../web/cd-scene.mjs');
  const THREE = await import('../web/vendor/three-r180/three.module.min.js');
  const images = [], states = [];
  const renderer = {shadowMap:{},debug:{},capabilities:{getMaxAnisotropy:() => 8},disposed:0,lost:0,
    setPixelRatio(value) { this.ratio = value; },setSize(width,height) { this.width = width; this.height = height; },
    render(scene,camera) { scene.updateMatrixWorld(true); camera.updateMatrixWorld(true); this.scene = scene; this.camera = camera; },
    dispose() { this.disposed++; },forceContextLoss() { this.lost++; }};
  const model = createCDScene({}, {}, {rendererFactory:() => renderer,environment:false,pixelRatio:3,
    createImage:() => { const image = {naturalWidth:0,naturalHeight:0,removeAttribute() { this.src = ''; }}; images.push(image); return image; },
    onArtwork:state => states.push(state),onInvalidate(){}});
  const pose = {yaw:0,pitch:0,lid:0,spin:0}; model.render(pose);
  return {THREE,model,renderer,images,states,pose};
}

test('vendored Three.js assets match the pinned version, checksums and MIT license', async () => {
  const base = 'web/vendor/three-r180/';
  const manifest = JSON.parse(fs.readFileSync(base + 'manifest.json','utf8'));
  assert.equal(manifest.version,'0.180.0');
  for (const [name,expected] of Object.entries(manifest.sha256)) {
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(base + name)).digest('hex'),expected,name);
  }
  assert.match(fs.readFileSync(base + 'LICENSE','utf8'), /The MIT License/);
  const THREE = await import('../web/vendor/three-r180/three.module.min.js'); assert.equal(THREE.REVISION,'180');
});

test('the real Three.js scene contains a hinged clear case, disc hole and independent holder', async () => {
  const f = await fixture(), scene = f.renderer.scene;
  const lid = scene.getObjectByName('case-lid'), disc = scene.getObjectByName('disc');
  assert.equal(scene.getObjectByName('clear-lid').material.transmission,0);
  assert.equal(scene.getObjectByName('clear-lid').material.transparent,true);
  assert.ok(scene.getObjectByName('clear-lid').material.opacity <= .1);
  assert.equal(scene.getObjectByName('clear-lid').material.roughness,0);
  assert.equal(scene.getObjectByName('clear-lid').material.thickness,0);
  assert.equal(scene.getObjectByName('clear-lid').material.ior,1.49);
  assert.ok(scene.getObjectByName('clear-lid').material.clearcoat > 0);
  assert.equal(scene.getObjectByName('disc-surface').geometry.parameters.innerRadius,.18);
  assert.equal(scene.getObjectsByProperty('name','hub-clip').length,12);
  assert.notEqual(scene.getObjectByName('disc-holder').parent,disc);
  f.model.render({...f.pose,lid:-Math.PI * .82,spin:1.2});
  assert.equal(lid.rotation.y,-Math.PI * .82); assert.equal(disc.rotation.z,1.2);
  assert.equal(scene.getObjectByName('album-insert').material.map,scene.getObjectByName('disc-label').material.map);
  f.model.dispose(); assert.equal(f.renderer.disposed,1); assert.equal(f.renderer.lost,1);
});

test('resting case geometry stays inside the camera view in portrait and landscape', async () => {
  const f = await fixture();
  for (const [width,height] of [[320,360],[1000,360],[2000,1000]]) {
    f.model.resize(width,height);
    assert.ok(f.renderer.width <= 1000 && f.renderer.height <= 540); assert.equal(f.renderer.ratio,1.25);
    assert.ok(Math.abs(f.renderer.camera.aspect - width / height) < .01);
    for (const lid of [0,-Math.PI * .82]) for (const yaw of [-1.5,-.28,1.5]) {
      f.model.render({...f.pose,lid,yaw,pitch:-.3});
      const group = f.renderer.scene.getObjectByName('cd-case');
      group.traverse(object => {
        const positions = object.geometry?.attributes.position;
        if (!positions) return;
        for (let i=0; i<positions.count; i+=3) {
          const point = new f.THREE.Vector3().fromBufferAttribute(positions,i).applyMatrix4(object.matrixWorld).project(f.renderer.camera);
          assert.ok(Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1,object.name + ' clipped');
        }
      });
    }
  }
  f.model.dispose();
});

test('cover textures update both insert and disc, reject stale loads, and release replaced textures', async () => {
  const f = await fixture();
  f.model.setArtwork('/covers/' + 'a'.repeat(64) + '.jpg'); const old = f.images[0], stale = old.onload;
  f.model.setArtwork('/covers/' + 'b'.repeat(64) + '.jpg'); stale();
  assert.equal(f.states.at(-1),'loading');
  const current = f.images[1]; current.naturalWidth = current.naturalHeight = 512; current.onload();
  const paper = f.renderer.scene.getObjectByName('album-insert').material;
  const texture = paper.map; let released = false; texture.addEventListener('dispose',() => { released = true; });
  assert.equal(texture.image,current); assert.equal(f.states.at(-1),'ready');
  f.model.setArtwork('/covers/' + 'b'.repeat(64) + '.jpg'); assert.equal(f.images.length,2);
  f.model.setArtwork(''); assert.equal(released,true); assert.equal(current.src,''); assert.notEqual(paper.map,texture);
  f.model.dispose();
});

test('disposal releases actual geometries and materials and ignores a late texture result', async () => {
  const f = await fixture(), resources = new Set();
  f.renderer.scene.traverse(object => { if (object.geometry) resources.add(object.geometry); if (object.material) resources.add(object.material); });
  const disposed = new Set(); for (const resource of resources) resource.addEventListener('dispose',() => disposed.add(resource));
  f.model.setArtwork('/covers/' + 'c'.repeat(64) + '.jpg'); const image = f.images[0], late = image.onload;
  f.model.dispose(); f.model.dispose(); late();
  assert.equal(disposed.size,resources.size); assert.equal(image.onload,null); assert.equal(image.onerror,null);
  assert.equal(f.renderer.disposed,1); assert.equal(f.renderer.lost,1);
});

test('plastic, artwork and lighting adapt to dark and light themes without reloading textures', async () => {
  const f = await fixture(), scene = f.renderer.scene;
  const lid = scene.getObjectByName('clear-lid'), edge = scene.getObjectByName('case-spine');
  assert.equal(lid.castShadow,false); assert.equal(edge.castShadow,false);
  assert.ok(edge.material.transmission > 0);
  assert.ok(lid.material.opacity < edge.material.transmission);
  const highlights = scene.getObjectsByProperty('name','plastic-highlight'); assert.equal(highlights.length,2);
  assert.equal(highlights[0].material,highlights[1].material);
  const paper = scene.getObjectByName('album-insert').material, print = scene.getObjectByName('disc-label').material;
  const insertBounds = new f.THREE.Box3().setFromObject(scene.getObjectByName('album-insert'));
  const plasticBounds = new f.THREE.Box3().setFromObject(lid);
  assert.ok(insertBounds.max.z < plasticBounds.min.z);
  for (const object of [scene.getObjectByName('disc'),scene.getObjectByName('disc-holder'),...scene.getObjectsByProperty('name','hub-clip')]) {
    assert.ok(new f.THREE.Box3().setFromObject(object).max.z < insertBounds.min.z,object.name + ' intersects the closed insert');
  }
  assert.ok(paper.isMeshBasicMaterial && print.isMeshBasicMaterial);
  assert.equal(paper.toneMapped,false); assert.equal(print.toneMapped,false);
  f.model.setArtwork('/covers/' + 'a'.repeat(64) + '.jpg');
  const image = f.images[0]; image.naturalWidth = image.naturalHeight = 512; image.onload();
  const texture = paper.map, lights = scene.children.filter(object => object.isLight);
  assert.equal(lights.filter(light => light.castShadow).length,1);
  assert.ok(lights.find(light => light.castShadow).shadow.mapSize.width <= 512);
  const floor = scene.getObjectByName('floor');
  f.model.setPalette({surface:'#17231e',accent:'#24754b'});
  const darkOpacity = floor.material.opacity, darkEdges = highlights[0].material.color.clone();
  f.model.setPalette({surface:'#ffffff',accent:'#74b9e8'});
  assert.ok(floor.material.opacity < darkOpacity); assert.equal(darkEdges.equals(highlights[0].material.color),false);
  assert.equal(paper.map,texture); assert.equal(print.map,texture); assert.equal(f.images.length,1);
  assert.equal(f.renderer.shadowMap.needsUpdate,true); assert.equal(f.renderer.transmissionResolutionScale,.5);
  f.model.dispose();
});
