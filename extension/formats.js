// Caption readers use seconds on the video's presentation timeline.
const IntertitleFormats = (() => {
  const decoder = new TextDecoder();
  const children = (el, name) => [...el.children].filter((x) => x.localName === name);
  const first = (el, name) => children(el, name)[0];
  const attr = (el, name) => [...el.attributes].find((a) => a.localName === name)?.value;
  const xml = (text) => new DOMParser().parseFromString(text, 'application/xml');
  const local = (value, base) => new URL(value, base).href;
  const language = (code) => {
    try {
      return new Intl.DisplayNames([navigator.language], { type: 'language' }).of(code);
    } catch {
      return code || 'Unspecified language';
    }
  };
  function time(s, tick = 1, fps = 30) {
    if (!s) return NaN;
    const unit = /^(\d+(?:\.\d+)?)(ms|h|m|s|t|f)$/.exec(s);
    if (unit)
      return Number(unit[1]) * { ms: 0.001, h: 3600, m: 60, s: 1, t: 1 / tick, f: 1 / fps }[unit[2]];
    const parts = s.replace(',', '.').split(':').map(Number);
    if (parts.length === 4) return parts[0] * 3600 + parts[1] * 60 + parts[2] + parts[3] / fps;
    return parts.reduce((v, n) => v * 60 + n, 0);
  }
  function ttml(text) {
    const doc = xml(text),
      root = doc.documentElement;
    if (root.localName !== 'tt') throw Error('The subtitle document is not readable TTML.');
    let fps = Number(attr(root, 'frameRate') || 30);
    const [mul, div] = (attr(root, 'frameRateMultiplier') || '1 1').split(/\s+/).map(Number);
    fps *= mul / div;
    const tick = Number(
      attr(root, 'tickRate') ||
        (attr(root, 'frameRate') ? fps * Number(attr(root, 'subFrameRate') || 1) : 1)
    );
    function words(node) {
      if (node.nodeType === 3 || node.nodeType === 4) return node.textContent.replace(/\s+/g, ' ');
      if (node.localName === 'br') return '\n';
      return [...node.childNodes].map(words).join('');
    }
    const cues = [];
    function visit(el, parentStart, parentEnd) {
      const start = parentStart + (time(el.getAttribute('begin'), tick, fps) || 0);
      const endAt = time(el.getAttribute('end'), tick, fps);
      const duration = time(el.getAttribute('dur'), tick, fps);
      const end = Math.min(
        parentEnd,
        Number.isFinite(endAt) ? parentStart + endAt : Infinity,
        Number.isFinite(duration) ? start + duration : Infinity
      );
      if (el.localName === 'p') {
        const text = words(el)
          .replace(/ *\n */g, '\n')
          .trim();
        if (text && Number.isFinite(end) && end > start) cues.push({ start, end, text });
      } else for (const child of el.children) visit(child, start, end);
    }
    visit(root, 0, Infinity);
    return cues;
  }
  function plain(s) {
    const named = {
      amp: '&',
      lt: '<',
      gt: '>',
      nbsp: ' ',
      lrm: '\u200e',
      rlm: '\u200f',
      quot: '"',
      apos: "'"
    };
    return s
      .replace(/<br\s*\/?\s*>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&(amp|lt|gt|nbsp|lrm|rlm|quot|apos|#\d+|#x[0-9a-f]+);/gi, (m, k) => {
        if (named[k]) return named[k];
        const n = k[1] === 'x' ? parseInt(k.slice(2), 16) : Number(k.slice(1));
        return n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
      })
      .trim();
  }
  function vtt(text) {
    const cues = [];
    for (const block of text.replace(/\r\n?/g, '\n').split(/\n[ \t]*\n/)) {
      const lines = block.split('\n');
      if (/^(?:NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0])) continue;
      const i = lines.findIndex((l) => l.includes('-->'));
      if (i < 0) continue;
      const pair = /^\s*([\d:.,]+)\s+-->\s+([\d:.,]+)/.exec(lines[i]);
      if (!pair) continue;
      const start = time(pair[1]),
        end = time(pair[2]),
        caption = plain(lines.slice(i + 1).join('\n'));
      if (caption && end > start) cues.push({ start, end, text: caption });
    }
    return cues;
  }
  function attributes(s) {
    return Object.fromEntries(
      [...s.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,\r\n]*)/g)].map((m) => [m[1], m[2].replace(/^"|"$/g, '')])
    );
  }
  function hlsTracks(text, url) {
    const tracks = new Map();
    for (const line of text.split(/\r?\n/).filter((l) => l.startsWith('#EXT-X-MEDIA:'))) {
      const a = attributes(line);
      if (a.TYPE !== 'SUBTITLES' || !a.URI) continue;
      const id = [a.LANGUAGE, a.NAME, a.FORCED, a.CHARACTERISTICS].join('/');
      tracks.set(id, {
        id,
        lang: a.LANGUAGE,
        label: a.NAME,
        kind:
          a.FORCED === 'YES' ? 'Forced' : /transcribes-spoken-dialog/.test(a.CHARACTERISTICS) ? 'CC' : '',
        url: local(a.URI, url),
        playlist: true
      });
    }
    return [...tracks.values()];
  }
  function hlsSegments(text, url) {
    const segments = [];
    let start = 0,
      duration,
      group = 0,
      init;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('#EXTINF:')) duration = parseFloat(line.slice(8));
      else if (line === '#EXT-X-DISCONTINUITY') group++;
      else if (line.startsWith('#EXT-X-MAP:')) init = local(attributes(line).URI, url);
      else if (line && line[0] !== '#' && Number.isFinite(duration)) {
        segments.push({ url: local(line, url), start, end: start + duration, group, init, hls: true });
        start += duration;
        duration = undefined;
      }
    }
    return segments;
  }
  function iso(s) {
    const m = /^P(?:(\d+)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(
      s || ''
    );
    return m
      ? Number(m[1] || 0) * 86400 + Number(m[2] || 0) * 3600 + Number(m[3] || 0) * 60 + Number(m[4] || 0)
      : NaN;
  }
  function dashTracks(text, url) {
    const mpd = xml(text).documentElement;
    if (mpd.localName !== 'MPD') return [];
    const result = new Map(),
      periods = children(mpd, 'Period');
    let cursor = 0;
    for (const [index, period] of periods.entries()) {
      const start = iso(period.getAttribute('start'));
      const offset = Number.isFinite(start) ? start : cursor;
      const next = iso(periods[index + 1]?.getAttribute('start'));
      const end = Number.isFinite(next) ? next : iso(mpd.getAttribute('mediaPresentationDuration'));
      const length = iso(period.getAttribute('duration')) || end - offset;
      cursor = offset + (length || 0);
      for (const set of children(period, 'AdaptationSet')) {
        const rep = first(set, 'Representation') || set;
        const nodes = [...new Set([mpd, period, set, rep])];
        if (
          !/text|subtitle|ttml|stpp|wvtt|vtt/i.test(
            nodes
              .flatMap((n) => ['contentType', 'mimeType', 'codecs'].map((a) => n.getAttribute(a)))
              .join(' ')
          )
        )
          continue;
        const bases = nodes.map((n) => first(n, 'BaseURL')?.textContent.trim()).filter(Boolean);
        const base = bases.reduce((b, s) => local(s, b), url);
        const lang = rep.getAttribute('lang') || set.getAttribute('lang') || 'und';
        const kind = children(set, 'Role')
          .map((r) => r.getAttribute('value'))
          .filter((r) => r && !['subtitle', 'main'].includes(r))
          .join(' ');
        const label = first(set, 'Label')?.textContent.trim() || language(lang);
        const id = [lang, label, kind].join('/');
        const segments = [];
        const templates = nodes.map((n) => first(n, 'SegmentTemplate')).filter(Boolean);
        const list = nodes
          .map((n) => first(n, 'SegmentList'))
          .filter(Boolean)
          .at(-1);
        if (templates.length || list) {
          const config = list ? [list] : templates;
          const get = (key) =>
            config
              .map((n) => n.getAttribute(key))
              .filter((v) => v !== null)
              .at(-1);
          const scale = Number(get('timescale') || 1),
            pto = Number(get('presentationTimeOffset') || 0);
          let number = Number(get('startNumber') || 1),
            ticks = 0;
          function expand(s) {
            return local(
              s.replace(/\$\$|\$(RepresentationID|Bandwidth|Time|Number)(?:%0(\d+)d)?\$/g, (m, k, p) => {
                if (m === '$$') return '$';
                return String(
                  {
                    RepresentationID: rep.getAttribute('id'),
                    Bandwidth: rep.getAttribute('bandwidth'),
                    Time: ticks,
                    Number: number
                  }[k]
                ).padStart(Number(p || 0), '0');
              }),
              base
            );
          }
          const initPath =
            get('initialization') || (list && first(list, 'Initialization')?.getAttribute('sourceURL'));
          const init = initPath ? expand(initPath) : undefined;
          const urls = list ? children(list, 'SegmentURL') : [];
          function append(d) {
            const media = list ? urls[segments.length]?.getAttribute('media') : get('media');
            if (!media) return false;
            segments.push({
              url: expand(media),
              init,
              start: offset + (ticks - pto) / scale,
              end: offset + (ticks + d - pto) / scale,
              period: offset,
              pto: pto / scale,
              scale
            });
            ticks += d;
            number++;
            return true;
          }
          const timeline = config
            .map((t) => first(t, 'SegmentTimeline'))
            .filter(Boolean)
            .at(-1);
          if (timeline) {
            const runs = children(timeline, 'S');
            for (const [i, s] of runs.entries()) {
              if (s.hasAttribute('t')) ticks = Number(s.getAttribute('t'));
              const d = Number(s.getAttribute('d')),
                r = Number(s.getAttribute('r') || 0);
              if (!(d > 0)) continue;
              const limit = runs[i + 1]?.getAttribute('t') ?? length * scale + pto;
              const count = r >= 0 ? r + 1 : Math.ceil((limit - ticks) / d);
              for (let j = 0; j < count && segments.length < 30000; j++) if (!append(d)) break;
            }
          } else {
            const d = Number(get('duration') || (length * scale) / (urls.length || 1));
            const count = list ? urls.length : Math.ceil((length * scale) / d);
            for (let j = 0; j < count && j < 30000; j++) if (!append(d)) break;
          }
        } else if (bases.length)
          segments.push({
            url: base,
            start: offset,
            end: offset + (length || Infinity),
            period: offset,
            whole: true
          });
        if (segments.length) {
          if (!result.has(id)) result.set(id, { id, lang, label, kind, segments: [] });
          result.get(id).segments.push(...segments);
        }
      }
    }
    return [...result.values()];
  }
  return { time, ttml, vtt, plain, language, hlsTracks, hlsSegments, dashTracks };
})();
