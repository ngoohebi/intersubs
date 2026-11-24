const IntertitleTracks = (() => {
  const F = IntertitleFormats,
    decoder = new TextDecoder();
  async function bytes(address, signal) {
    const url = new URL(address, location.href);
    if (url.protocol !== 'https:' || url.username || url.password) throw Error('Invalid subtitle address.');
    try {
      const res = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) });
      if (!res.ok) throw Error('Subtitle request returned ' + res.status);
      return new Uint8Array(await res.arrayBuffer());
    } catch (error) {
      signal.throwIfAborted();
      const result = await chrome.runtime.sendMessage({ type: 'read-subtitles', url: url.href });
      if (!result?.data) throw Error(result?.error || error.message);
      return Uint8Array.from(atob(result.data), (c) => c.charCodeAt(0));
    }
  }
  function lazyUrl(track, key, signal) {
    return new Promise((resolve, reject) => {
      const token = crypto.randomUUID(),
        timer = setTimeout(() => finish(null, 'Netflix took too long to load this track.'), 20000);
      function finish(url, error) {
        clearTimeout(timer);
        document.removeEventListener('intertitles:resolved', receive);
        signal.removeEventListener('abort', cancel);
        error ? reject(Error(error)) : resolve(url);
      }
      function cancel() {
        finish(null, 'Selection changed.');
      }
      function receive(e) {
        const item = JSON.parse(e.detail);
        if (item.token === token) finish(item.url, item.error);
      }
      document.addEventListener('intertitles:resolved', receive);
      signal.addEventListener('abort', cancel, { once: true });
      document.dispatchEvent(
        new CustomEvent('intertitles:resolve', { detail: JSON.stringify({ id: track.id, key, token }) })
      );
    });
  }
  function boxes(data, start = 0, end = data.length) {
    const view = new DataView(data.buffer, data.byteOffset, data.length),
      result = [];
    while (start + 8 <= end) {
      let size = view.getUint32(start),
        header = 8;
      if (size === 1 && start + 16 <= end) {
        size = Number(view.getBigUint64(start + 8));
        header = 16;
      }
      if (!size) size = end - start;
      if (size < header || start + size > end) break;
      result.push({
        type: decoder.decode(data.subarray(start + 4, start + 8)),
        at: start + header,
        end: start + size,
        start
      });
      start += size;
    }
    return result;
  }
  function fragment(data, segment, scale) {
    const view = new DataView(data.buffer, data.byteOffset, data.length);
    const top = boxes(data),
      cues = [];
    const nested = (b) => boxes(data, b.at, b.end);
    const mdat = top.find((b) => b.type === 'mdat');
    if (!mdat) throw Error('Unrecognized subtitle segment.');
    for (const moof of top.filter((b) => b.type === 'moof')) {
      for (const traf of nested(moof).filter((b) => b.type === 'traf')) {
        const list = nested(traf),
          tfhd = list.find((b) => b.type === 'tfhd'),
          tfdt = list.find((b) => b.type === 'tfdt');
        if (!tfhd || !tfdt || !scale) throw Error('Missing subtitle fragment timing.');
        const flags = view.getUint32(tfhd.at) & 0xffffff;
        let p = tfhd.at + 8 + (flags & 1 ? 8 : 0) + (flags & 2 ? 4 : 0);
        const defaultDur = flags & 8 ? view.getUint32(p) : 0;
        if (flags & 8) p += 4;
        const defaultSize = flags & 16 ? view.getUint32(p) : 0;
        const stamp = view.getUint8(tfdt.at)
          ? Number(view.getBigUint64(tfdt.at + 4))
          : view.getUint32(tfdt.at + 4);
        let pos = mdat.at,
          ticks = stamp;
        for (const run of list.filter((b) => b.type === 'trun')) {
          const bits = view.getUint32(run.at) & 0xffffff,
            count = view.getUint32(run.at + 4);
          p = run.at + 8;
          if (bits & 1) {
            pos = moof.start + view.getInt32(p);
            p += 4;
          }
          if (bits & 4) p += 4;
          for (let i = 0; i < count; i++) {
            const duration = bits & 256 ? view.getUint32(p) : defaultDur;
            if (bits & 256) p += 4;
            const size = bits & 512 ? view.getUint32(p) : defaultSize;
            if (bits & 512) p += 4;
            if (bits & 1024) p += 4;
            const comp = bits & 2048 ? view.getInt32(p) : 0;
            if (bits & 2048) p += 4;
            if (!size || pos + size > data.length) throw Error('Invalid subtitle sample size.');
            const start = (segment.period || 0) + (ticks + comp) / scale - (segment.pto || 0);
            const sample = data.subarray(pos, pos + size);
            if (/^\s*</.test(decoder.decode(sample.subarray(0, 80)))) {
              cues.push(...align(F.ttml(decoder.decode(sample)), segment));
            } else {
              for (const cue of boxes(sample).filter((b) => b.type === 'vttc')) {
                const payload = boxes(sample, cue.at, cue.end).find((b) => b.type === 'payl');
                if (payload)
                  cues.push({
                    start,
                    end: start + duration / scale,
                    text: F.plain(decoder.decode(sample.subarray(payload.at, payload.end)))
                  });
              }
            }
            pos += size;
            ticks += duration;
          }
        }
      }
    }
    return cues;
  }
  function initScale(data) {
    let items = boxes(data);
    for (const type of ['moov', 'trak', 'mdia', 'mdhd']) {
      const box = items.find((b) => b.type === type);
      if (!box) return 0;
      if (type === 'mdhd')
        return new DataView(data.buffer, data.byteOffset, data.length).getUint32(
          box.at + (data[box.at] ? 20 : 12)
        );
      items = boxes(data, box.at, box.end);
    }
  }
  function shift(cues, offset) {
    return cues.map((c) => ({ ...c, start: c.start + offset, end: c.end + offset }));
  }
  function align(cues, seg) {
    const offset = (seg.period || 0) - (seg.pto || 0);
    if (
      !seg.whole &&
      cues.length &&
      cues.every((c) => c.end + offset <= seg.start + 0.001) &&
      cues[0].start < seg.end - seg.start
    )
      return shift(cues, seg.start);
    return shift(cues, offset);
  }
  function mapTime(text) {
    const line = text.match(/X-TIMESTAMP-MAP[^\r\n]*/i)?.[0];
    if (!line) return null;
    const pts = Number(line.match(/MPEGTS:(\d+)/i)?.[1]) / 90000;
    const local = F.time(line.match(/LOCAL:([\d:.]+)/i)?.[1]);
    return Number.isFinite(pts + local) ? { pts, local } : null;
  }
  function indexed(cues) {
    cues.sort((a, b) => a.start - b.start);
    let longest = 0;
    for (const cue of cues) longest = Math.max(longest, cue.end - cue.start);
    return (time) => {
      let left = 0,
        right = cues.length;
      while (left < right) {
        const m = (left + right) >>> 1;
        if (cues[m].start <= time) left = m + 1;
        else right = m;
      }
      const active = [];
      for (let i = left - 1; i >= 0 && cues[i].start + longest > time; i--)
        if (cues[i].end > time) active.unshift(cues[i].text);
      return active.join('\n');
    };
  }
  async function reader(track, key, signal, warn) {
    if (track.native) {
      let count = -1,
        first,
        last,
        fallback;
      return (time) => {
        const active = [...(track.native.activeCues || [])].filter(
          (c) => c.startTime <= time && c.endTime > time
        );
        if (active.length) return active.map((c) => F.plain(c.text || '')).join('\n');
        // Chrome may defer activeCues until playback resumes after changing a track's mode.
        const cues = track.native.cues;
        if (!cues?.length) return '';
        if (count !== cues.length || first !== cues[0] || last !== cues[cues.length - 1]) {
          count = cues.length;
          first = cues[0];
          last = cues[count - 1];
          fallback = indexed(
            [...cues].map((c) => ({ start: c.startTime, end: c.endTime, text: F.plain(c.text || '') }))
          );
        }
        return fallback(time);
      };
    }
    const url = track.lazy ? await lazyUrl(track, key, signal) : track.url;
    let segments = track.segments;
    if (!segments) {
      const body = decoder.decode(await bytes(url, signal));
      if (body.trimStart().startsWith('#EXTM3U')) segments = F.hlsSegments(body, url);
      else if (/^\s*</.test(body)) return indexed(F.ttml(body));
      else if (body.includes('-->') || body.startsWith('WEBVTT')) return indexed(F.vtt(body));
      else throw Error('The provider returned an unsupported subtitle format.');
    }
    if (!segments.length) throw Error('The subtitle playlist is empty.');
    const cache = new Map(),
      origins = new Map(),
      initials = new Map();
    function cached(map, key, load) {
      if (!map.has(key))
        map.set(
          key,
          load().catch((error) => {
            map.delete(key);
            throw error;
          })
        );
      return map.get(key);
    }
    async function load(seg) {
      const raw = await bytes(seg.url, signal),
        head = decoder.decode(raw.subarray(0, 256)).trimStart();
      let cues;
      if (head.startsWith('WEBVTT') || head.includes('-->')) {
        const body = decoder.decode(raw),
          map = mapTime(body);
        cues = F.vtt(body);
        if (seg.hls && map) {
          const first = segments.find((s) => s.group === seg.group);
          const origin = await cached(origins, seg.group, async () => {
            const zero = first === seg ? map : mapTime(decoder.decode(await bytes(first.url, signal)));
            return (zero?.pts || 0) - first.start;
          });
          // Unwrap the 33-bit MPEG presentation timestamp at the current segment.
          const wrap = 2 ** 33 / 90000,
            delta = map.pts - origin;
          const adjusted = delta + Math.round((seg.start - delta) / wrap) * wrap;
          cues = shift(cues, adjusted - map.local);
        } else cues = align(cues, seg);
      } else if (head.startsWith('<')) cues = align(F.ttml(decoder.decode(raw)), seg);
      else {
        const scale = seg.init
          ? await cached(initials, seg.init, async () => initScale(await bytes(seg.init, signal)))
          : initScale(raw) || seg.scale;
        cues = fragment(raw, seg, scale);
      }
      return indexed(cues);
    }
    function get(i) {
      if (!cache.has(i)) {
        const state = {};
        cache.set(i, state);
        state.ready = load(segments[i]).then(
          (read) => {
            state.read = read;
          },
          (e) => {
            state.error = e;
          }
        );
        if (cache.size > 16) cache.delete(cache.keys().next().value);
      }
      return cache.get(i);
    }
    return (time) => {
      let lo = 0,
        hi = segments.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (segments[mid].start <= time) lo = mid + 1;
        else hi = mid;
      }
      const i = lo - 1;
      if (i < 0 || time >= segments[i].end) return '';
      const state = get(i);
      if (state.error && !state.reported) {
        state.reported = true;
        warn(state.error);
      }
      if (i + 1 < segments.length && time + 4 >= segments[i + 1].start) get(i + 1);
      const prev = cache.get(i - 1)?.read?.(time),
        current = state.read?.(time);
      return [...new Set([prev, current].filter(Boolean))].join('\n');
    };
  }
  return { reader, bytes };
})();
