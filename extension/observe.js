// Runs alongside the player so manifests consumed before the picker opens are retained.
(() => {
  const emit = (type, data) =>
    document.dispatchEvent(new CustomEvent('intertitles:' + type, { detail: JSON.stringify(data) }));
  const netflix = location.hostname.endsWith('netflix.com');
  let last,
    route = location.pathname,
    order = 0,
    accepted = 0;
  const netflixManifests = new Map();

  function publish(packet, path = location.pathname, sequence = ++order) {
    if (path !== location.pathname || sequence < accepted) return;
    accepted = sequence;
    route = path;
    last = packet;
    emit('catalog', { path, ...packet });
  }

  function fromJSON(data, url, path, seq) {
    if (!data || typeof data !== 'object') return;
    const playback = data.timedTextUrls?.result || data.resources?.playbackResources || data;
    const forced = Array.isArray(playback.forcedNarrativeUrls) ? playback.forcedNarrativeUrls : [];
    const prime = [...(Array.isArray(playback.subtitleUrls) ? playback.subtitleUrls : []), ...forced];
    if (prime.length || Array.isArray(playback.subtitleUrls)) {
      const tracks = prime
        .filter((t) => t.url)
        .map((t) => ({
          id: t.timedTextTrackId || t.trackId || t.url,
          lang: t.languageCode || t.language,
          label: t.displayName,
          kind: forced.includes(t) ? 'Forced' : t.type,
          url: t.url
        }));
      const query = new URL(url).searchParams;
      publish({ key: query.get('titleId') || query.get('entityId') || url, tracks }, path, seq);
    }
    const manifest = data.result || data;
    const subtitleTracks = manifest.timedtexttracks || manifest.textTracks;
    if (netflix && Array.isArray(subtitleTracks)) {
      const id = String(manifest.movieId ?? manifest.viewableId ?? '');
      const tracks = subtitleTracks.flatMap((track) => {
        if (track.isNoneTrack || track.isImageBased) return [];
        const formats = Object.entries(track.ttDownloadables || track.downloadables || {}).filter(([k]) =>
          /vtt|imsc|dfxp|simplesdh/i.test(k)
        );
        const file = formats
          .map(([, f]) => Object.values(f.downloadUrls || {})[0] || f.urls?.[0]?.url)
          .find(Boolean);
        if (typeof file !== 'string' || !track.language) return [];
        return [
          {
            id: String(track.trackId ?? track.id ?? track.new_track_id ?? file),
            lang: track.language,
            label: track.languageDescription === 'Off' ? undefined : track.languageDescription,
            kind: track.isForcedNarrative ? 'Forced' : track.rawTrackType,
            url: file
          }
        ];
      });
      if (id && (tracks.length || !subtitleTracks.length)) {
        netflixManifests.set(id, tracks);
        if (netflixManifests.size > 6) netflixManifests.delete(netflixManifests.keys().next().value);
        if (!location.pathname.includes('/watch/') || location.pathname.endsWith('/' + id))
          publish({ key: id, tracks }, path, seq);
      }
    }
    const master = data.stream?.sources?.find((s) => s.complete?.url)?.complete.url;
    if (master && /disneyplus\./.test(location.hostname)) {
      publish({ key: master, master }, path, seq);
    }
  }

  const parse = JSON.parse;
  function examine(body, url, path, seq) {
    if (typeof body !== 'string') return fromJSON(body, url, path, seq);
    if (
      /#EXT-X-MEDIA:[^\r\n]*TYPE=SUBTITLES/.test(body) ||
      (/<(?:\w+:)?MPD[\s>]/.test(body) &&
        /wvtt|stpp|ttml|text\/vtt|contentType=.[Ss]?(?:text|subtitle)/i.test(body))
    ) {
      publish({ key: url, url, manifest: body }, path, seq);
    } else if (/^\s*\{/.test(body)) fromJSON(parse(body), url, path, seq);
  }
  const interesting = (url, mime = '') =>
    /\/cadmium\/manifest\/|\.mpd\b|\.m3u8\b|Get(?:Vod)?PlaybackResources|playerChromeResources/i.test(
      url
    ) || /dash\+xml|mpegurl/i.test(mime);

  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const path = location.pathname,
      seq = ++order;
    return originalFetch.apply(this, args).then((response) => {
      try {
        if (response.ok && interesting(response.url, response.headers.get('content-type'))) {
          response
            .clone()
            .text()
            .then((body) => examine(body, response.url, path, seq))
            .catch(() => {});
        }
      } catch {
        /* Observations are optional for the player. */
      }
      return response;
    });
  };
  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (...args) {
    const path = location.pathname,
      seq = ++order;
    this.addEventListener(
      'load',
      () => {
        try {
          const url = this.responseURL;
          if (!interesting(url, this.getResponseHeader('Content-Type'))) return;
          if (this.responseType === 'document')
            examine(new XMLSerializer().serializeToString(this.responseXML), url, path, seq);
          else if (this.responseType === 'arraybuffer')
            examine(new TextDecoder().decode(this.response), url, path, seq);
          else examine(this.response, url, path, seq);
        } catch {
          /* An unrelated or unreadable response does not affect playback. */
        }
      },
      { once: true }
    );
    return open.apply(this, args);
  };

  if (netflix || /disneyplus\./.test(location.hostname)) {
    const inspect = (data) => {
      try {
        if (
          data?.result?.textTracks ||
          data?.result?.timedtexttracks ||
          data?.timedtexttracks ||
          data?.stream?.sources
        )
          fromJSON(data, location.href, location.pathname, ++order);
      } catch {}
      return data;
    };
    JSON.parse = function (...args) {
      return inspect(parse.apply(this, args));
    };
    const json = Response.prototype.json;
    Response.prototype.json = function () {
      return json.call(this).then(inspect);
    };
  }

  function session() {
    const app = window.netflix?.appContext?.state?.playerApp;
    const api = app?.getAPI()?.videoPlayer;
    const id = api?.getAllPlayerSessionIds()?.at(-1);
    if (!id) return {};
    const player = api.getVideoPlayerBySessionId(id);
    return { player, root: app.getState?.()?.videoPlayer?.cadmiumPlayerRepository?.playersById?.[id] };
  }

  function playerTracks() {
    const { player } = session();
    if (!player) return false;
    const key = String(player.getMovieId());
    const watchId = /\/watch\/(\d+)/.exec(location.pathname)?.[1];
    if (watchId && watchId !== key) return false;
    const files = netflixManifests.get(key) || [];
    const tracks = (player.getTimedTextTrackList() || [])
      .filter((t) => t.bcp47 && !t.isNoneTrack && !t.isImageBased)
      .map((t) => {
        const id = String(t.trackId),
          known = files.find((f) => f.id === id);
        return {
          id,
          lang: t.bcp47,
          label: t.displayName,
          kind: t.isForcedNarrative ? 'Forced' : t.rawTrackType,
          url: known?.url,
          lazy: !known
        };
      });
    if (!tracks.length) return false;
    publish({ key, tracks });
    return true;
  }

  function lookup(root, id) {
    const queue = [root],
      visited = new WeakSet();
    for (let i = 0; i < queue.length && i < 25000; i++) {
      const obj = queue[i];
      if (
        !obj ||
        typeof obj !== 'object' ||
        visited.has(obj) ||
        ArrayBuffer.isView(obj) ||
        obj instanceof Node
      )
        continue;
      visited.add(obj);
      if (obj.type === 'timedtext' && String(obj.trackId) === id && obj.urls?.[0]?.url)
        return obj.urls[0].url;
      for (const v of Object.values(obj)) if (v && typeof v === 'object') queue.push(v);
    }
  }
  if (location.hostname.endsWith('disneyplus.com')) {
    // Disney can rebase the HTML media timeline at ad breaks. Its player exposes
    // the title-relative playhead in milliseconds on the React player component.
    let boundVideo,
      player,
      lastLookup = -Infinity;
    function isPlayer(candidate) {
      return (
        typeof candidate?.seek === 'function' &&
        Number.isFinite(candidate.timeline?.info?.playheadPositionMs)
      );
    }
    function findDisneyPlayer(video) {
      for (let node = video; node; node = node.parentElement) {
        const key = Object.keys(node).find((k) => k.startsWith('__reactFiber$'));
        if (!key) continue;
        let fiber = node[key];
        for (let i = 0; fiber && i < 180; i++, fiber = fiber.return) {
          const owners = [fiber.memoizedProps, fiber.stateNode];
          let hook = fiber.memoizedState;
          for (let j = 0; hook && j < 25; j++, hook = hook.next) owners.push(hook.memoizedState);
          for (const owner of owners) {
            if (isPlayer(owner)) return owner;
            if (!owner || typeof owner !== 'object' || owner instanceof Node || Array.isArray(owner))
              continue;
            const candidate = Object.values(owner).find(isPlayer);
            if (candidate) return candidate;
          }
        }
        break;
      }
    }
    document.addEventListener('intertitles:read-clock', (e) => {
      try {
        if (boundVideo !== e.target || (!player && performance.now() - lastLookup > 5000)) {
          boundVideo = e.target;
          lastLookup = performance.now();
          player = findDisneyPlayer(boundVideo);
        }
        const ms = player?.timeline?.info?.playheadPositionMs;
        if (Number.isFinite(ms))
          document.dispatchEvent(new CustomEvent('intertitles:clock', { detail: ms / 1000 }));
      } catch {
        player = undefined;
      }
    });
  }
  let pending = Promise.resolve();
  document.addEventListener('intertitles:resolve', (e) => {
    if (!netflix) return;
    const { id, key, token } = parse(e.detail);
    pending = pending
      .then(async () => {
        const { player, root } = session();
        if (!player || String(player.getMovieId()) !== key) throw Error('The title changed.');
        let url = lookup(root, id);
        if (!url) {
          const track = player.getTimedTextTrackList().find((t) => String(t.trackId) === id);
          if (!track) throw Error('This subtitle track is no longer available.');
          const before = player.getTimedTextTrack();
          try {
            await player.setTimedTextTrack(track);
            for (let i = 0; i < 24 && !url; i++) {
              await new Promise((resolve) => setTimeout(resolve, 200));
              if (String(player.getMovieId()) !== key) break;
              url = lookup(session().root, id);
            }
          } finally {
            if (
              before &&
              String(player.getMovieId()) === key &&
              player.getTimedTextTrack()?.trackId === track.trackId
            )
              await player.setTimedTextTrack(before);
          }
        }
        if (!url) throw Error('Netflix has not supplied text for this track. Try another language.');
        emit('resolved', { token, url });
      })
      .catch((error) => emit('resolved', { token, error: error.message }));
  });
  document.addEventListener('intertitles:scan', () => {
    try {
      if (netflix && playerTracks()) return;
    } catch {}
    if (route === location.pathname && last) emit('catalog', { path: route, ...last });
    else if (netflix) {
      const id = /\/watch\/(\d+)/.exec(location.pathname)?.[1];
      const tracks = netflixManifests.get(id);
      if (tracks) publish({ key: id, tracks });
    }
  });
})();
