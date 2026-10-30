/* Load the selected dictionary before evaluating application scripts. */
(async () => {
  await MusicI18n.initialize();
  for (const placeholder of document.querySelectorAll('script[data-app-src]')) {
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = placeholder.dataset.appSrc;
      script.onload = resolve;
      script.onerror = () => reject(Error('Could not load ' + script.src));
      document.head.append(script);
    });
  }
})().catch(error => {
  console.error(error);
  const status = document.getElementById('playbackError');
  status.hidden = false;
  status.textContent = MusicI18n.translate('Could not start the player. Reload the page.');
});
