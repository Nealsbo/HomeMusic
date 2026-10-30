/* Views receive a snapshot, never the audio element, queue, or server API. */
(function(root) {
  const factories = new Map();
  function placeholder(title, description, symbol) {
    return () => {
      let container;
      return {
        mount(element) { container = element; },
        update() {
          const markup = '<div class="player-placeholder"><div class="player-placeholder-symbol" aria-hidden="true">' + symbol +
            '</div><h2>' + escapeHTML(tr(title)) + '</h2><p>' + escapeHTML(tr(description)) + '</p></div>';
          if (container.innerHTML !== markup) container.innerHTML = markup;
        },
        setActive() {},
        dispose() { container?.replaceChildren(); container = null; }
      };
    };
  }
  root.playerViews = Object.freeze({
    register(id, factory) { factories.set(id,factory); },
    has(id) { return factories.has(id); },
    create(id, context = {}) {
      const factory = factories.get(id);
      if (!factory) throw Error('Unknown player view');
      return factory(context);
    }
  });
  // Keep playback usable if the optional artwork module cannot be loaded.
  root.playerViews.register('album',placeholder('Album artwork', 'This view is unavailable. Playback will continue.', '♫'));
  root.playerViews.register('effects',placeholder('Effects', 'This view is unavailable. Playback will continue.', '≋'));
  root.playerViews.register('cd',placeholder('CD', 'This view is unavailable. Playback will continue.', '◉'));
})(globalThis);
