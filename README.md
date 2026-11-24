# Intersubs

Intersubs is a Chrome extension for watching with two subtitle languages. It discovers the tracks offered for the current title on Netflix, Prime Video, HBO Max, and Disney+. The larger first line and smaller green second line follow the player as you watch or seek.

## Install in desktop Chrome

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select the **extension** folder in this project.
3. Reload the streaming tab, start a title, and click **Intersubs** in Chrome’s Extensions menu. Pin it for quick access.

## Choose your languages

Select a provider track for **First line** and a different track for **Second line**. Click **Show subtitles**. Reopen Intertitles to change the pair or **Turn off** to return to the player’s captions. **Rescan** checks the current title again after playback starts. If the next title reports an empty subtitle catalog, Intertitles clears the old captions and shows **No tracks found**.

For a translated second line, expand **Advanced translation** and enable **Translate the second line with Chrome**. Choose any detected provider track under **Translate from**. That choice is independent of the first displayed line. For example, you can display Japanese on top and translate an English subtitle track into Traditional Chinese underneath.

**Translate into** lists Chrome’s 39 documented target languages and checks availability for your chosen source on your device. The picker shows which pairs are ready, need a download, or are unavailable. Translation uses desktop Chrome 138 or newer. Keep the streaming tab open during the first language pack download. [Chrome Translator API](https://developer.chrome.com/docs/ai/translator-api)

## Playback and privacy

The extension reads player-provided text tracks, subtitle manifests, and the selected subtitle files. Captions, signed track URLs, and translations stay in memory for the tab. Chrome downloads its translation models and performs translation on the device. The extension has no account, analytics, or cloud translation service.

Track availability depends on the title, region, and player version. **Forced** tracks contain occasional captions, often for signs or foreign dialogue. Image-only subtitles and burned-in captions have no text track for the picker. The HLS and DASH readers target on-demand playback. The provider’s picture-in-picture window does not include the page overlay.

## Verification

The browser suite installs the unpacked extension in an isolated Chrome for Testing profile. It opens the real toolbar action against controlled Netflix, Prime Video, Disney+, and HBO Max response formats and checks selection, simultaneous cues, seeking, provider changes, and translation-source independence.

```sh
npm ci
npx playwright install chromium
npm test
```

Live checks covered the English and Traditional Chinese tracks on Netflix’s public *Stranger Things* trailer and actual Spanish-to-English translation in desktop Chrome. The HLS and DASH readers were also exercised with Apple’s BipBop and Shaka’s Angel One streams. Subscription playback on Prime Video, Disney+, and HBO Max still needs a signed-in check.

## Related projects

- [Language Reactor](https://www.languagereactor.com/) is the reference for the dual-subtitle viewing workflow.
- [asbplayer](https://github.com/asbplayer/asbplayer) is an open-source subtitle study tool. Its [compatibility guide](https://docs.asbplayer.dev/docs/compatibility/) covers all four services.
- [MultiSubtitle](https://github.com/Arthur0099/MultiSubtitle-Chrome-Extension) is an open-source project focused on displaying a second Netflix subtitle track.
