// Some signed subtitle CDNs permit the player to load text but omit CORS headers.
const cdns = chrome.runtime.getManifest().host_permissions.map((pattern) => pattern.slice(10, -2));
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message?.type !== 'read-subtitles' || !sender.tab || sender.id !== chrome.runtime.id) return;
  (async () => {
    const url = new URL(message.url);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !cdns.some((domain) => url.hostname === domain || url.hostname.endsWith('.' + domain))
    ) {
      throw Error('This subtitle server requires access through the player.');
    }
    const response = await fetch(url, {
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(20000)
    });
    if (!response.ok) throw Error('Subtitle server returned ' + response.status + '.');
    if (Number(response.headers.get('Content-Length')) > 16 * 1024 * 1024)
      throw Error('Subtitle document is too large.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > 16 * 1024 * 1024) throw Error('Subtitle document is too large.');
    if (bytes.toBase64) return bytes.toBase64();
    const chunks = [];
    for (let i = 0; i < bytes.length; i += 0x6000)
      chunks.push(String.fromCharCode(...bytes.subarray(i, i + 0x6000)));
    return btoa(chunks.join(''));
  })().then(
    (data) => reply({ data }),
    (error) => reply({ error: error.message })
  );
  return true;
});
