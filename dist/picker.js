const IntertitlePicker = (() => {
  function node(tag, text, props = {}) {
    const el = Object.assign(document.createElement(tag), props);
    if (text) el.textContent = text;
    return el;
  }
  const css = new CSSStyleSheet();
  css.replaceSync(`
    :host{all:initial!important;position:fixed!important;inset:0!important;display:block!important;z-index:2147483647!important;pointer-events:none!important}
    *,*::before,*::after{box-sizing:border-box}
    [hidden]{display:none!important}
    .panel{color-scheme:dark;position:absolute;right:16px;top:16px;width:min(346px,calc(100vw - 24px));max-height:calc(100vh - 32px);overflow:auto;
      border:1px solid #48504a;border-radius:16px;background:#171d1a;color:#f2f4ef;box-shadow:0 12px 48px #0008;
      font:14px/1.45 "DM Sans",system-ui,sans-serif;pointer-events:auto;text-align:left;padding:20px}
    header,.row,.buttons,footer{display:flex;align-items:center;gap:10px}
    header{border-bottom:1px solid #373f38;padding-bottom:15px;margin-bottom:16px}
    h1{font:650 19px/1.15 "DM Sans",system-ui,sans-serif;letter-spacing:-.6px;margin:0}
    header small{color:#b0bcb3;font-size:12px;display:block;margin-top:4px}
    .mark{width:36px;height:36px;border-radius:10px;background:#c0efaf;display:grid;place-content:center;gap:4px;flex-shrink:0}
    .mark i{width:18px;height:4px;background:#1b3725;border-radius:2px}.mark i+i{width:12px}
    button,select,input,summary{font:inherit}button,select,summary,input{cursor:pointer}
    button{border-radius:8px;padding:8px 12px;background:#27312b;border:1px solid #4a554c;color:#ebf1e9;font-weight:600}
    button:hover{filter:brightness(1.12)}button:disabled,select:disabled{cursor:default;opacity:.48}
    .close{margin-left:auto;border:0;background:transparent;color:#c0c9c2;font-size:23px;padding:0 7px}
    .field{display:block;margin:12px 0}.caption{display:block;margin-bottom:5px;font-weight:600;color:#e4e9e3}
    select{width:100%;min-height:38px;padding:7px 9px;border-radius:7px;border:1px solid #47534a;background:#232b26;color:#f3f5f1}
    details{margin:16px 0;border-block:1px solid #374239;padding:12px 0}summary{font-weight:570}
    .row{margin-top:13px}.row input{accent-color:#b8eca8;width:16px;height:16px}
    .hint,.status{font-size:12px;color:#b5c3b7;margin:8px 0}.status:empty{display:none}
    .apply{background:#c0efaf;border-color:#c0efaf;color:#17341f;flex:1}
    :focus-visible{outline:2px solid #cbf9b9;outline-offset:3px}
    footer{justify-content:space-between;margin:0 0 9px;color:#aab9ae;font-size:12px}
    .refresh{background:none;border:none;color:#c0efaf;font-size:12px;padding:4px}
    .subs{position:fixed;display:flex;align-items:center;flex-direction:column;justify-content:flex-end;gap:3px;pointer-events:none;text-align:center}
    .line{max-width:95%;padding:.1em .45em;border-radius:.2em;background:rgb(8 10 9/.86);color:white;font:600 var(--size,28px)/1.22 "Atkinson Hyperlegible Next",Arial,sans-serif;
      white-space:pre-line;overflow-wrap:anywhere;text-shadow:0 1px 2px #000}
    .line+.line{font-size:calc(var(--size,28px)*.85);color:#d6f5c7}.line:empty{display:none}
  `);
  function create() {
    const host = node('div');
    host.id = 'intertitles-controls';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.adoptedStyleSheets = [css];
    const panel = node('section', null, { className: 'panel', hidden: true });
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Subtitle languages');
    const provider = /netflix/.test(location.host)
      ? 'Netflix'
      : /disney/.test(location.host)
        ? 'Disney+'
        : /max\.com/.test(location.host)
          ? 'HBO Max'
          : 'Prime Video';
    const head = node('header'),
      brand = node('div'),
      icon = node('span', null, { className: 'mark' });
    icon.append(node('i'), node('i'));
    brand.append(node('h1', 'Intertitles'), node('small', provider + ' subtitles'));
    const close = node('button', '×', { className: 'close', title: 'Close settings' });
    close.setAttribute('aria-label', 'Close settings');
    head.append(icon, brand, close);
    const footer = node('footer'),
      count = node('span'),
      refresh = node('button', 'Rescan', { className: 'refresh' });
    footer.append(count, refresh);
    function field(label) {
      const wrap = node('label', null, { className: 'field' }),
        select = node('select');
      select.setAttribute('aria-label', label);
      wrap.append(node('span', label, { className: 'caption' }), select);
      return { wrap, select };
    }
    const first = field('First line'),
      second = field('Second line'),
      source = field('Translate from'),
      target = field('Translate into');
    const advanced = node('details'),
      summary = node('summary', 'Advanced translation');
    const toggle = node('label', null, { className: 'row' }),
      ai = node('input', null, { type: 'checkbox' });
    toggle.append(ai, document.createTextNode('Translate the second line with Chrome'));
    const options = node('div', null, { hidden: true }),
      hint = node('p', null, { className: 'hint' });
    options.append(source.wrap, target.wrap, hint);
    advanced.append(summary, toggle, options);
    const status = node('p', null, { className: 'status' });
    status.setAttribute('role', 'status');
    const buttons = node('div', null, { className: 'buttons' }),
      stop = node('button', 'Turn off', { hidden: true }),
      apply = node('button', 'Show subtitles', { className: 'apply' });
    buttons.append(stop, apply);
    panel.append(head, footer, first.wrap, second.wrap, advanced, status, buttons);
    const subs = node('div', null, { className: 'subs' }),
      lines = [
        node('div', null, { className: 'line', dir: 'auto' }),
        node('div', null, { className: 'line', dir: 'auto' })
      ];
    subs.append(...lines);
    shadow.append(subs, panel);
    for (const event of ['click', 'pointerdown', 'pointerup', 'keydown', 'keyup', 'wheel'])
      panel.addEventListener(event, (e) => e.stopPropagation());
    return {
      host,
      panel,
      count,
      refresh,
      close,
      first: first.select,
      second: second.select,
      secondWrap: second.wrap,
      source: source.select,
      target: target.select,
      ai,
      options,
      hint,
      status,
      stop,
      apply,
      subs,
      lines,
      advanced
    };
  }
  return { create };
})();
