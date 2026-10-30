/* Load the selected dictionary before evaluating application scripts. */
(async () => {
  await MusicI18n.initialize();
  for (const placeholder of document.querySelectorAll('script[data-app-src]')) {
    try {
      await new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = placeholder.dataset.appSrc;
        script.onload = resolve;
        script.onerror = () => reject(Error('Could not load ' + script.src));
        document.head.append(script);
      });
    } catch (error) {
      if (placeholder.dataset.optional !== 'true') throw error;
      console.warn('Optional player view could not be loaded',error);
      continue;
    }
    if (placeholder.dataset.appSrc === '/client-session.js') await browserSession.ready;
  }
})().catch(error => {
  console.error(error);
  const status = document.getElementById('playbackError');
  status.hidden = false;
  status.textContent = MusicI18n.translate('Could not start the player. Reload the page.');
});
