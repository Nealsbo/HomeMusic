const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const {themes,find} = require('../web/themes.js');

const tokens = name => Object.fromEntries([...fs.readFileSync(`web/themes/${name}.css`,'utf8')
  .matchAll(/--([\w-]+):\s*(#[\da-f]{6})/gi)].map(match => [match[1],match[2]]));
function luminance(hex) {
  const rgb = hex.slice(1).match(/../g).map(part => parseInt(part,16) / 255)
    .map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4);
  return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722;
}
function contrast(a,b) { const values = [luminance(a),luminance(b)].sort((a,b) => b - a); return (values[0] + .05) / (values[1] + .05); }

test('the theme set contains four light and four dark independently served palettes', () => {
  assert.equal(themes.length,8); assert.equal(themes.filter(theme => theme.dark).length,4);
  assert.equal(new Set(themes.map(theme => theme.id)).size,8);
  for (const theme of themes) assert.ok(tokens(theme.id).bg);
  assert.equal(find('unknown'),undefined);
});

test('new palettes keep text and action labels readable against their surfaces', () => {
  for (const name of ['latte','dawn','nord','mocha','dracula']) {
    const palette = {...tokens('forest'),...tokens(name)};
    for (const background of ['bg','surface']) for (const text of ['ink','muted','soft-ink']) {
      assert.ok(contrast(palette[text],palette[background]) >= 4.5,`${name}: ${text} on ${background}`);
    }
    assert.ok(contrast(palette.green,palette['on-accent']) >= 4.5,name + ': action label');
  }
});
