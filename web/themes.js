/* Shared theme metadata; each palette's CSS remains a standalone stylesheet. */
(function(root) {
  const themes = Object.freeze([
    {id:'forest',label:'Forest · light',dark:false,primary:'#24754b',secondary:'#a5bc77'},
    {id:'sand',label:'Sand · light',dark:false,primary:'#9b5634',secondary:'#d8a568'},
    {id:'latte',label:'Latte · light',dark:false,primary:'#8839ef',secondary:'#179299'},
    {id:'dawn',label:'Dawn · light',dark:false,primary:'#b4637a',secondary:'#286983'},
    {id:'midnight',label:'Midnight · dark',dark:true,primary:'#74b9e8',secondary:'#a592ff'},
    {id:'nord',label:'Nord · dark',dark:true,primary:'#88c0d0',secondary:'#b48ead'},
    {id:'mocha',label:'Mocha · dark',dark:true,primary:'#cba6f7',secondary:'#94e2d5'},
    {id:'dracula',label:'Dracula · dark',dark:true,primary:'#bd93f9',secondary:'#50fa7b'}
  ].map(theme => Object.freeze(theme)));
  const find = id => themes.find(theme => theme.id === id);
  const palettes = Object.freeze([
    {id:'polar',label:'Polar colors',primary:'#53efb5',secondary:'#a777ff'},
    {id:'sunset',label:'Sunset colors',primary:'#ffad66',secondary:'#d76ba5'},
    {id:'neon',label:'Neon colors',primary:'#49dafa',secondary:'#ec69ef'}
  ].map(palette => Object.freeze(palette)));
  const findPalette = id => find(id) || palettes.find(palette => palette.id === id);
  const api = Object.freeze({themes,palettes,find,findPalette});
  root.MusicThemes = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(globalThis);
