import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const extension = fileURLToPath(new URL('../extension', import.meta.url));
const clock = (await readFile(new URL('clock.webm', import.meta.url))).toString('base64');
const tracks = { en: 'English', fr: 'Français', es: 'Español' };
const serviceURL = {
  netflix: 'https://www.netflix.com/watch/101',
  prime: 'https://www.primevideo.com/detail/title',
  disney: 'https://www.disneyplus.com/play/title',
  hbo: 'https://play.hbomax.com/video/watch/title'
};
const video =
  '<video muted preload="auto" style="width:720px;height:405px" src="data:video/webm;base64,' +
  clock +
  '"></video>';
let context, browser, id;

before(async () => {
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [
      '--disable-extensions-except=' + extension,
      '--load-extension=' + extension,
      '--enable-unsafe-extension-debugging'
    ]
  });
  browser = await context.browser().newBrowserCDPSession();
  id = (await browser.send('Extensions.getExtensions')).extensions.find((e) => e.path === extension).id;
});
after(async () => await context?.close());

function vtt(lang, start = 0, localMap = '') {
  const cue = (s) => '00:00:' + String(s).padStart(2, '0') + '.000';
  return (
    'WEBVTT\n' +
    localMap +
    '\n' +
    [0, 10]
      .map((s, i) => cue(start + s) + ' --> ' + cue(start + s + 8) + '\n' + lang + ' line ' + (i + 1))
      .join('\n\n') +
    '\n'
  );
}
function fixture(service) {
  const files = {};
  let script;
  for (const lang of Object.keys(tracks)) files['/' + lang + '.vtt'] = vtt(lang);
  if (service === 'netflix') {
    const timedtexttracks = Object.entries(tracks).map(([language, languageDescription]) => ({
      language,
      languageDescription,
      trackId: language,
      ttDownloadables: {
        imsc: { downloadUrls: { a: new URL('/' + language + '.ttml', serviceURL.netflix).href } }
      }
    }));
    script =
      'JSON.parse(' + JSON.stringify(JSON.stringify({ result: { movieId: 101, timedtexttracks } })) + ');';
    for (const lang of Object.keys(tracks))
      files['/' + lang + '.ttml'] =
        '<tt xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:tickRate="10000000"><body><div><p begin="0t" dur="80000000t">' +
        lang +
        ' line 1</p><p begin="100000000t" end="180000000t">' +
        lang +
        ' line 2</p></div></body></tt>';
  } else if (service === 'prime') {
    files['/GetVodPlaybackResources'] = JSON.stringify({
      timedTextUrls: {
        result: {
          subtitleUrls: Object.entries(tracks).map(([lang, label]) => ({
            languageCode: lang,
            displayName: label,
            url: new URL('/' + lang + '.vtt', serviceURL.prime).href
          }))
        }
      }
    });
    script = 'fetch("/GetVodPlaybackResources?titleId=film").then(r=>r.json());';
  } else if (service === 'disney') {
    files['/playback'] = JSON.stringify({
      stream: { sources: [{ complete: { url: new URL('/master.m3u8', serviceURL.disney).href } }] }
    });
    files['/master.m3u8'] =
      '#EXTM3U\n' +
      Object.entries(tracks)
        .map(
          ([lang, name]) =>
            '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="' +
            lang +
            '",NAME="' +
            name +
            '",URI="' +
            lang +
            '.m3u8"'
        )
        .join('\n');
    for (const lang of Object.keys(tracks)) {
      files['/' + lang + '.m3u8'] =
        '#EXTM3U\n#EXTINF:10,\n' + lang + '-1.vtt\n#EXTINF:10,\n' + lang + '-2.vtt\n#EXT-X-ENDLIST';
      for (const i of [1, 2])
        files['/' + lang + '-' + i + '.vtt'] =
          'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:' +
          ((i - 1) * 900000 + 90000) +
          '\n\n00:00:00.000 --> 00:00:08.000\n' +
          lang +
          ' line ' +
          i;
    }
    script = 'fetch("/playback").then(r=>r.json());';
  } else {
    files['/movie.mpd'] =
      '<MPD mediaPresentationDuration="PT20S"><Period>' +
      Object.entries(tracks)
        .map(
          ([lang, label]) =>
            '<AdaptationSet lang="' +
            lang +
            '" mimeType="text/vtt"><Label>' +
            label +
            '</Label><SegmentTemplate media="$RepresentationID$-$Number$.vtt"><SegmentTimeline><S d="10" r="1"/></SegmentTimeline></SegmentTemplate><Representation id="' +
            lang +
            '"/></AdaptationSet>'
        )
        .join('') +
      '</Period></MPD>';
    for (const lang of Object.keys(tracks))
      for (const i of [1, 2])
        files['/' + lang + '-' + i + '.vtt'] =
          'WEBVTT\n\n00:00:00.000 --> 00:00:08.000\n' + lang + ' line ' + i;
    script =
      'const xhr=new XMLHttpRequest();xhr.open("GET","/movie.mpd");xhr.responseType="arraybuffer";xhr.send();';
  }
  return { files, script };
}
async function open(page) {
  await page.bringToFront();
  const { targetInfos } = await browser.send('Target.getTargets', { filter: [{ type: 'tab' }] });
  const tab = targetInfos.find((t) => t.url === page.url());
  await browser.send('Extensions.triggerAction', { id, targetId: tab.targetId });
  await page.getByRole('dialog', { name: 'Subtitle languages' }).waitFor();
}
async function load(service, custom) {
  const page = await context.newPage(),
    url = serviceURL[service],
    { files, script } = custom ?? fixture(service);
  page.setDefaultTimeout(6000);
  await page.route('**/*', (r) => {
    const path = new URL(r.request().url()).pathname;
    if (r.request().url() === url)
      return r.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><meta charset=utf-8>' + video + '<script>' + script + '</script>'
      });
    if (path in files) return r.fulfill({ contentType: 'text/plain', body: files[path] });
    return r.abort();
  });
  await page.goto(url);
  await page.waitForFunction(() => document.querySelector('video[src]').readyState >= 2);
  await open(page);
  return page;
}
async function lines(page, values) {
  await page.waitForFunction(
    (values) => {
      const root = document.querySelector('#intertitles-controls')?.shadowRoot;
      return root && [...root.querySelectorAll('.line')].every((e, i) => e.textContent === values[i]);
    },
    values,
    { timeout: 6000 }
  );
}
async function seek(page, t) {
  await page.locator('video').evaluate((v, time) => {
    v.currentTime = time;
  }, t);
}

for (const service of Object.keys(serviceURL))
  test(service + ' discovers provider languages and plays the selected tracks across seeks', async () => {
    const page = await load(service);
    try {
      const first = page.getByLabel('First line'),
        second = page.getByLabel('Second line', { exact: true });
      assert.deepEqual(await first.locator('option').allTextContents(), Object.values(tracks));
      await first.selectOption({ label: 'Español' });
      await second.selectOption({ label: 'Français' });
      await page.getByRole('button', { name: 'Show subtitles' }).click();
      await lines(page, ['es line 1', 'fr line 1']);
      await seek(page, 12);
      await lines(page, ['es line 2', 'fr line 2']);
      await seek(page, 9);
      await lines(page, ['', '']);
      await seek(page, 2);
      await lines(page, ['es line 1', 'fr line 1']);
      await open(page);
      await page.getByRole('button', { name: 'Turn off' }).click();
      await lines(page, ['', '']);
    } finally {
      await page.close();
    }
  });

test('Advanced checks all Chrome targets for an independently chosen source and discards late translations', async () => {
  const page = await load('prime');
  try {
    // Only the translation model is substituted. The extension, controls, network and video clock are real.
    const session = await context.newCDPSession(page);
    const worlds = [];
    session.on('Runtime.executionContextCreated', (e) => worlds.push(e.context));
    await session.send('Runtime.enable');
    let world;
    for (const ctx of worlds) {
      const result = await session.send('Runtime.evaluate', {
        contextId: ctx.id,
        expression: 'typeof intertitlesPlayer'
      });
      if (result.result.value === 'object') world = ctx.id;
    }
    assert.ok(world);
    await session.send('Runtime.evaluate', {
      contextId: world,
      expression: `
      globalThis.Translator={availability:async ({sourceLanguage,targetLanguage})=>sourceLanguage==='es' && targetLanguage==='ja'?'available':'unavailable',
        create:async p=>({destroy(){},translate:async text=>{await new Promise(r=>setTimeout(r,480));return p.sourceLanguage+'>'+p.targetLanguage+' '+text;}})}
    `
    });
    await page.getByText('Advanced translation', { exact: true }).click();
    await page.getByRole('checkbox').check();
    await page.getByLabel('Translate from').selectOption({ label: 'Español' });
    const target = page.getByLabel('Translate into');
    await page.waitForFunction(
      () =>
        document.querySelector('#intertitles-controls').shadowRoot.querySelectorAll('select')[3].value ===
        'ja'
    );
    assert.equal(await target.locator('option').count(), 39);
    assert.equal(await target.locator('option:not(:disabled)').count(), 1);
    await page.getByRole('button', { name: 'Show subtitles' }).click();
    await lines(page, ['en line 1', '']);
    await seek(page, 12);
    await lines(page, ['en line 2', 'es>ja es line 2']);
    await seek(page, 9);
    await lines(page, ['', '']);
  } finally {
    await page.close();
  }
});

test('Netflix resolves lazy subtitle URLs in sequence and restores the player selection', async () => {
  const page = await load('netflix', {
    files: fixture('prime').files,
    script: `
    const off={isNoneTrack:true,trackId:'off'};
    const options=['en','fr'].map(lang=>({trackId:lang,bcp47:lang,displayName:lang}));
    const root={};let current=off;
    const player={getMovieId:()=>101,getTimedTextTrackList:()=>[off,...options],getTimedTextTrack:()=>current,
      setTimedTextTrack:async t=>{current=t;document.body.dataset.active=t.trackId;root[t.trackId]={type:'timedtext',trackId:t.trackId,urls:[{url:location.origin+'/'+t.trackId+'.vtt'}]}}};
    window.netflix={appContext:{state:{playerApp:{getAPI:()=>({videoPlayer:{getAllPlayerSessionIds:()=>['session'],getVideoPlayerBySessionId:()=>player}}),
      getState:()=>({videoPlayer:{cadmiumPlayerRepository:{playersById:{session:root}}}})}}}};
  `
  });
  try {
    await page.getByRole('button', { name: 'Show subtitles' }).click();
    await lines(page, ['en line 1', 'fr line 1']);
    assert.equal(await page.locator('body').getAttribute('data-active'), 'off');
  } finally {
    await page.close();
  }
});

test('native tracks restore their original modes and a new title clears its predecessor', async () => {
  const page = await load('disney', {
    files: {},
    script: `
    const v=document.querySelector('video'); for(const lang of ['en','es']){const t=v.addTextTrack('subtitles',lang,lang);
    t.addCue(new VTTCue(0,8,lang));t.mode=lang==='en'?'showing':'disabled';}
  `
  });
  try {
    await page.getByRole('button', { name: 'Show subtitles' }).click();
    await lines(page, ['en', 'es']);
    await page.evaluate(() => history.pushState({}, '', '/play/next'));
    await lines(page, ['', '']);
    assert.deepEqual(await page.locator('video').evaluate((v) => [...v.textTracks].map((t) => t.mode)), [
      'showing',
      'disabled'
    ]);
  } finally {
    await page.close();
  }
});

test('a Netflix trailer dialog receives settings clicks and uses current textTracks metadata', async () => {
  const { files } = fixture('prime');
  files['/playapi/cadmium/manifest/1'] = JSON.stringify({
    result: {
      movieId: 202,
      textTracks: Object.entries(tracks).map(([lang, label]) => ({
        id: lang,
        language: lang,
        languageDescription: label,
        downloadables: {
          'webvtt-lssdh-ios8': { urls: [{ url: 'https://www.netflix.com/' + lang + '.vtt' }] }
        }
      }))
    }
  });
  const page = await load('netflix', {
    files,
    script: `
    history.replaceState({},'', '/title/101');
    const modal=document.createElement('div');modal.setAttribute('role','dialog');document.body.append(modal);
    modal.append(document.querySelector('video'));
    const backdrop=document.createElement('video');backdrop.style='width:100vw;height:100vh';document.body.append(backdrop);
    document.addEventListener('click',e=>{if(!modal.contains(e.target))e.stopImmediatePropagation();},true);
    fetch('/playapi/cadmium/manifest/1').then(r=>r.json());
  `
  });
  try {
    await page.getByRole('button', { name: 'Show subtitles' }).click();
    await lines(page, ['en line 1', 'fr line 1']);
    assert.equal(
      await page.locator('#intertitles-controls').evaluate((el) => el.parentElement.getAttribute('role')),
      'dialog'
    );
  } finally {
    await page.close();
  }
});

test('Disney subtitle segments use its content playhead after an ad timeline offset', async () => {
  const disney = fixture('disney');
  disney.script +=
    ";document.querySelector('video').__reactFiber$fixture={memoizedProps:{player:{seek(){},timeline:{info:{playheadPositionMs:12000}}}}};";
  const page = await load('disney', disney);
  try {
    await page.getByRole('button', { name: 'Show subtitles' }).click();
    await lines(page, ['en line 2', 'fr line 2']);
  } finally {
    await page.close();
  }
});

test('Prime clears active captions when the next title on the same page reports no tracks', async () => {
  const prime = fixture('prime');
  prime.files['/next/playerChromeResources'] = JSON.stringify({
    resources: { playbackResources: { subtitleUrls: [], forcedNarrativeUrls: [] } }
  });
  const page = await load('prime', prime);
  try {
    await page.getByRole('button', { name: 'Show subtitles' }).click();
    await lines(page, ['en line 1', 'fr line 1']);
    await page.evaluate(() => fetch('/next/playerChromeResources?entityId=next').then((r) => r.json()));
    await lines(page, ['', '']);
    await open(page);
    assert.deepEqual(await page.getByLabel('First line').locator('option').allTextContents(), [
      'No tracks found'
    ]);
    assert.equal(await page.getByRole('button', { name: 'Show subtitles' }).isDisabled(), true);
  } finally {
    await page.close();
  }
});
