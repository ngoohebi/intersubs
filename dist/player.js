(() => {
  const F = IntertitleFormats,
    T = IntertitleTracks;
  // Chrome publishes a language list and exposes availability per pair.
  const targets =
    'ar bg bn cs da de el en es fi fr he hi hr hu id it ja kn ko lt mr nl no pl pt ro ru sk sl sv ta te th tr uk vi zh zh-Hant'.split(
      ' '
    );
  const names = new Map(targets.map((code) => [code, F.language(code === 'zh' ? 'zh-Hans' : code)]));
  targets.sort((a, b) => names.get(a).localeCompare(names.get(b)));
  let ui,
    video,
    path = location.pathname,
    catalog = [],
    key = '',
    signature = '',
    tracks = [],
    run,
    timer,
    lastCheck = 0;
  let loading = false,
    pairVersion = 0,
    scanVersion = 0,
    masterRead,
    packetStamp = '',
    previousFocus;
  const nativeIDs = new WeakMap();
  let nextNative = 0;
  function normalize(code) {
    try {
      const locale = new Intl.Locale(code.replaceAll('_', '-'));
      if (locale.language === 'zh') return locale.maximize().script === 'Hant' ? 'zh-Hant' : 'zh';
      if (locale.language === 'nb') return 'no';
      return locale.language;
    } catch {
      return '';
    }
  }
  function area(v) {
    const b = v.getBoundingClientRect();
    return (
      Math.max(0, Math.min(b.right, innerWidth) - Math.max(0, b.left)) *
      Math.max(0, Math.min(b.bottom, innerHeight) - Math.max(0, b.top))
    );
  }
  function findVideo() {
    const candidates = [...document.querySelectorAll('video')].filter(
      (v) => area(v) > 0 && v.checkVisibility({ checkVisibilityCSS: true, checkOpacity: true })
    );
    // Logged-out previews and episode backgrounds can leave larger paused videos underneath a modal.
    const modal = candidates.filter((v) => v.closest('dialog[open],[aria-modal="true"],[role="dialog"]'));
    return (modal.length ? modal : candidates).sort(
      (a, b) => Number(a.paused || a.ended) - Number(b.paused || b.ended) || area(b) - area(a)
    )[0];
  }
  function mount() {
    // Modal players trap input inside their dialog. Keep our controls in that same subtree.
    const dialog = video?.closest('dialog[open],[aria-modal="true"],[role="dialog"]');
    const parent = document.fullscreenElement || dialog || document.documentElement;
    if (parent && ui.host.parentNode !== parent) parent.append(ui.host);
  }
  function collect() {
    if (!ui) return;
    const list = [...catalog].sort(
      (a, b) => Number(/forced/i.test(a.kind || '')) - Number(/forced/i.test(b.kind || ''))
    );
    for (const t of video?.textTracks || []) {
      if (!['subtitles', 'captions'].includes(t.kind)) continue;
      // A player may expose placeholder native tracks alongside its complete manifest.
      if (catalog.some((c) => c.lang?.toLowerCase() === t.language.toLowerCase())) continue;
      if (!nativeIDs.has(t)) nativeIDs.set(t, 'native:' + ++nextNative);
      list.push({
        id: nativeIDs.get(t),
        lang: t.language,
        label: t.label,
        kind: t.kind === 'captions' ? 'CC' : '',
        native: t
      });
    }
    tracks = list;
    const sig = JSON.stringify(list.map((t) => [t.id, t.lang, t.label, t.kind]));
    if (sig === signature) return;
    signature = sig;
    const labels = list.map((t) => {
      const base = t.label || F.language(t.lang);
      const kind = t.kind?.replace(/closedcaptions?|sdh/i, 'CC').replace(/^subtitles?$/i, '');
      const suffix = kind && !base.toLowerCase().includes(kind.toLowerCase()) ? ' · ' + kind : '';
      return base + suffix;
    });
    for (const select of [ui.first, ui.second, ui.source]) {
      const prev = select.value;
      select.replaceChildren(...list.map((t, i) => new Option(labels[i], t.id)));
      if (list.some((t) => t.id === prev)) select.value = prev;
      else if (select === ui.second) select.selectedIndex = list.findIndex((t) => t.lang !== list[0]?.lang);
    }
    if (!list.length)
      for (const s of [ui.first, ui.second, ui.source])
        s.add(new Option(key ? 'No tracks found' : 'Waiting for tracks…', ''));
    if (list.length === 1 && !ui.ai.checked)
      ui.status.textContent =
        'One provider track is available. Open Advanced translation for a second language.';
    else if (!list.length)
      ui.status.textContent = key
        ? 'The player reported no readable subtitle tracks for this title.'
        : 'Start the title, then rescan. Reload the streaming tab if playback began before installation.';
    else if (!run) ui.status.textContent = '';
    ui.count.textContent = list.length + ' provider track' + (list.length === 1 ? '' : 's');
    updatePairs();
  }
  function pick(select) {
    return tracks.find((t) => t.id === select.value);
  }
  function controls() {
    const translation = ui.ai.checked,
      first = pick(ui.first);
    for (const op of ui.second.options) op.disabled = op.value === ui.first.value;
    if (ui.second.selectedOptions[0]?.disabled)
      ui.second.selectedIndex = [...ui.second.options].findIndex((o) => !o.disabled);
    ui.options.hidden = !translation;
    ui.secondWrap.hidden = translation;
    const allowed = translation
      ? Boolean(pick(ui.source) && ui.target.value && !ui.target.selectedOptions[0]?.disabled)
      : Boolean(pick(ui.second) && ui.first.value !== ui.second.value);
    ui.apply.disabled = loading || !video || !first || !allowed;
    for (const field of [ui.first, ui.second, ui.ai, ui.source, ui.target, ui.refresh])
      field.disabled = loading;
    ui.stop.hidden = !run;
  }
  async function updatePairs() {
    const version = ++pairVersion;
    controls();
    if (!ui.ai.checked) return;
    const sourceLanguage = normalize(pick(ui.source)?.lang || ''),
      before = ui.target.value;
    ui.target.replaceChildren();
    ui.apply.disabled = true;
    ui.hint.textContent = 'Checking language packs on this device…';
    const api = globalThis.Translator;
    const results = await Promise.all(
      targets.map(async (targetLanguage) => {
        if (!api || !sourceLanguage || sourceLanguage === targetLanguage) return 'unavailable';
        try {
          return await api.availability({ sourceLanguage, targetLanguage });
        } catch {
          return 'unavailable';
        }
      })
    );
    if (version !== pairVersion) return;
    ui.target.replaceChildren(
      ...targets.map((code, i) => {
        const state = results[i],
          disabled = state === 'unavailable';
        const note = disabled
          ? 'unavailable'
          : state === 'available'
            ? 'ready'
            : state === 'downloading'
              ? 'downloading'
              : 'download';
        const op = new Option(names.get(code) + ' · ' + note, code);
        op.disabled = disabled;
        return op;
      })
    );
    const preferred = [
      before,
      normalize(navigator.language),
      normalize(pick(ui.second)?.lang || ''),
      'en',
      ...targets
    ].find((c) => targets.includes(c) && results[targets.indexOf(c)] !== 'unavailable');
    ui.target.selectedIndex = preferred ? targets.indexOf(preferred) : -1;
    ui.hint.textContent = !api
      ? 'Chrome’s built-in Translator is unavailable here. Use desktop Chrome 138 or newer.'
      : !preferred
        ? 'Chrome has no available target for this source on this device.'
        : 'Chrome may download a language pack the first time you use a pair.';
    controls();
  }

  function stop() {
    if (run) {
      run.controller.abort();
      run.translator?.destroy();
      for (const [track, before] of run.modes) if (track.mode === 'hidden') track.mode = before;
      run = null;
    }
    loading = false;
    if (ui) {
      ui.lines.forEach((l) => (l.textContent = ''));
      document.documentElement.classList.remove('intertitles-active');
      controls();
    }
  }
  async function receive(e) {
    let packet;
    try {
      packet = JSON.parse(e.detail);
    } catch {
      return;
    }
    if (packet.path !== location.pathname) return;
    if (path !== location.pathname) resetRoute();
    const stamp = e.detail;
    if (packetStamp === stamp) return;
    packetStamp = stamp;
    const version = ++scanVersion;
    try {
      let list = packet.tracks;
      if (!list) {
        let data = packet.manifest,
          url = packet.url;
        if (packet.master) {
          url = packet.master;
          masterRead?.abort();
          masterRead = new AbortController();
          data = new TextDecoder().decode(await T.bytes(url, masterRead.signal));
        }
        if (!data) return;
        list = data.trimStart().startsWith('#EXTM3U') ? F.hlsTracks(data, url) : F.dashTracks(data, url);
      }
      if (version !== scanVersion || packet.path !== location.pathname || !Array.isArray(list)) return;
      // An explicitly empty catalog belongs to this title too. A player can load
      // the next episode in place without changing its URL or replacing the video.
      if (key && (key !== packet.key || (!list.length && catalog.length))) stop();
      key = packet.key;
      catalog = [...new Map(list.map((t) => [String(t.id), { ...t, id: String(t.id) }])).values()];
      collect();
    } catch {
      if (version === scanVersion) packetStamp = '';
    }
  }
  document.addEventListener('intertitles:catalog', receive);
  function resetRoute() {
    stop();
    masterRead?.abort();
    scanVersion++;
    packetStamp = '';
    key = '';
    catalog = [];
    signature = 'reset';
    path = location.pathname;
  }
  function scan() {
    if (path !== location.pathname) resetRoute();
    const now = findVideo();
    if (video !== now) {
      if (video) stop();
      video = now;
      signature = 'rescan';
    }
    document.dispatchEvent(new Event('intertitles:scan'));
    collect();
    controls();
  }
  const hideNative = new CSSStyleSheet();
  hideNative.replaceSync(`
    .intertitles-active video::-webkit-media-text-track-container{visibility:hidden!important}
    .intertitles-active :is(.player-timedtext,.atvwebplayersdk-captions-overlay,.atvwebplayersdk-captions-text,.dss-subtitle-renderer,.shaka-text-container,.vjs-text-track-display,.bmpui-ui-subtitle-overlay,[data-testid="subtitles-container"]){visibility:hidden!important}
  `);
  function setLine(index, text) {
    if (ui.lines[index].textContent !== text) ui.lines[index].textContent = text;
  }
  function translated(s, source) {
    if (!source || s.cache.has(source)) return s.cache.get(source) || '';
    if (!s.translating) {
      s.translating = true;
      s.translator
        .translate(source, { signal: s.controller.signal })
        .then((result) => {
          if (run !== s) return;
          if (s.cache.size > 250) s.cache.delete(s.cache.keys().next().value);
          s.cache.set(source, result);
        })
        .catch((error) => {
          if (run === s) showError(error);
        })
        .finally(() => {
          s.translating = false;
        });
    }
    return '';
  }
  const disney = location.hostname.endsWith('disneyplus.com');
  let titleTime;
  document.addEventListener('intertitles:clock', (e) => {
    if (Number.isFinite(e.detail)) titleTime = e.detail;
  });
  function render() {
    const s = run;
    if (!s?.readers || !video) return;
    const rect = video.getBoundingClientRect(),
      time = video.currentTime;
    ui.subs.style.left = rect.left + 'px';
    ui.subs.style.width = rect.width + 'px';
    ui.subs.style.bottom = innerHeight - rect.bottom + Math.min(100, rect.height * 0.1) + 'px';
    ui.subs.style.setProperty('--size', Math.min(50, Math.max(15, rect.width * 0.027)) + 'px');
    const showing = rect.width && rect.height && !video.ended && !video.seeking;
    titleTime = time;
    if (showing && disney) video.dispatchEvent(new Event('intertitles:read-clock', { bubbles: true }));
    const top = showing ? s.readers[0](s.native[0] ? time : titleTime) : '',
      lower = showing ? s.readers[1](s.native[1] ? time : titleTime) : '';
    if (run !== s) return;
    setLine(0, top);
    setLine(1, s.translator ? translated(s, lower) : lower);
  }
  function showError(error) {
    stop();
    ui.panel.hidden = false;
    ui.status.textContent = error?.message || 'Could not load these subtitles. Rescan and try again.';
  }
  async function apply() {
    if (ui.apply.disabled) return;
    stop();
    loading = true;
    const s = { controller: new AbortController(), modes: new Map(), cache: new Map() };
    run = s;
    const signal = s.controller.signal,
      ai = ui.ai.checked;
    const selected = [pick(ui.first), pick(ai ? ui.source : ui.second)];
    const sourceLanguage = normalize(selected[1].lang),
      targetLanguage = ui.target.value;
    controls();
    ui.status.textContent = ai ? 'Preparing Chrome translation…' : 'Loading subtitles…';
    try {
      // Start create() directly in the trusted click handler, before any await.
      const model = ai
        ? globalThis.Translator.create({
            sourceLanguage,
            targetLanguage,
            signal,
            monitor(m) {
              m.addEventListener('downloadprogress', (e) => {
                if (run === s)
                  ui.status.textContent = 'Downloading language pack · ' + Math.round(e.loaded * 100) + '%';
              });
            }
          })
            .then((t) => {
              if (signal.aborted) {
                t.destroy();
                signal.throwIfAborted();
              }
              s.translator = t;
            })
            .catch((e) => {
              if (signal.aborted) throw e;
              throw Error(
                'Chrome could not start this language pair. Check the connection for the first download, then press Show subtitles to retry.'
              );
            })
        : Promise.resolve();
      const read = new Map();
      for (const t of selected) {
        if (read.has(t.id)) continue;
        if (t.native) {
          s.modes.set(t.native, t.native.mode);
          t.native.mode = 'hidden';
        }
        read.set(
          t.id,
          T.reader(t, key, signal, (e) => {
            if (run === s) showError(e);
          })
        );
      }
      const [, first, second] = await Promise.all([model, ...selected.map((t) => read.get(t.id))]);
      if (run !== s) return;
      s.native = selected.map((t) => Boolean(t.native));
      s.readers = [first, second];
      loading = false;
      controls();
      document.documentElement.classList.add('intertitles-active');
      ui.lines[0].lang = selected[0].lang || '';
      ui.lines[1].lang = ai ? targetLanguage : selected[1].lang || '';
      ui.status.textContent = 'Subtitles are on.';
      close();
      render();
    } catch (error) {
      if (run === s) showError(error);
    }
  }
  function close() {
    ui.panel.hidden = true;
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    if (!run) {
      clearInterval(timer);
      timer = null;
    }
  }
  function open() {
    if (!ui) {
      ui = IntertitlePicker.create();
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, hideNative];
      ui.close.onclick = close;
      ui.stop.onclick = () => {
        stop();
        ui.status.textContent = 'Subtitles are off.';
      };
      ui.refresh.onclick = () => {
        signature = 'rescan';
        packetStamp = '';
        scan();
      };
      ui.apply.onclick = apply;
      ui.ai.onchange = updatePairs;
      ui.source.onchange = updatePairs;
      ui.first.onchange = controls;
      ui.second.onchange = controls;
      ui.target.onchange = controls;
      ui.panel.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') close();
      });
      document.addEventListener('fullscreenchange', () => {
        mount();
        render();
      });
    }
    previousFocus = document.activeElement;
    ui.panel.hidden = false;
    signature = 'rescan';
    scan();
    mount();
    ui.first.focus({ preventScroll: true });
    if (!timer)
      timer = setInterval(() => {
        if (performance.now() - lastCheck > 1100) {
          lastCheck = performance.now();
          if (!ui.panel.hidden || path !== location.pathname || !video?.isConnected || !area(video)) scan();
          if (ui.panel.hidden && !run) {
            clearInterval(timer);
            timer = null;
            return;
          }
          mount();
        }
        render();
      }, 80);
  }
  globalThis.intertitlesPlayer = {
    score: () => {
      const v = findVideo();
      return v ? area(v) : 0;
    }
  };
  chrome.runtime.onMessage.addListener((m, _sender, respond) => {
    if (m.type === 'open-picker') {
      open();
      respond(true);
    }
  });
})();
