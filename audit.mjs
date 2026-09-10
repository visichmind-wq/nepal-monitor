import { chromium } from 'playwright';

const TARGET = process.argv[2] || '/home/claude/nepal-monitor/index.html';
const FILE = 'file://' + TARGET;
const SHOTNAME = TARGET.split('/').pop().replace(/\.html$/, '');
const VIEWPORTS = [
  { w: 320, h: 900, n: '320 (малий телефон)' },
  { w: 375, h: 900, n: '375 (iPhone)' },
  { w: 430, h: 950, n: '430 (Pro Max)' },
  { w: 768, h: 1024, n: '768 (планшет)' },
  { w: 860, h: 900, n: '860' },
  { w: 1024, h: 900, n: '1024' },
  { w: 1100, h: 900, n: '1100' },
  { w: 1280, h: 900, n: '1280' },
  { w: 1440, h: 900, n: '1440 (десктоп)' },
];

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' });
let problems = 0;

// три стани, які реально бувають у глядача:
// system-light / system-dark (нічого не проштамповано) + явний вибір теми через data-theme
const MODES = [
  { scheme: 'light', stamp: null,   n: 'light ' },
  { scheme: 'dark',  stamp: null,   n: 'dark  ' },
  { scheme: 'light', stamp: 'dark', n: 'dark!  ' },  // явно ввімкнена темна на світлій ОС
  { scheme: 'dark',  stamp: 'light', n: 'light! ' }, // явно ввімкнена світла на темній ОС
];

for (const mode of MODES) {
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.w, height: vp.h },
      colorScheme: mode.scheme,
      deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    await page.goto(FILE, { waitUntil: 'load' });
    if (mode.stamp) {
      await page.evaluate(t => document.documentElement.setAttribute('data-theme', t), mode.stamp);
    }
    await page.waitForTimeout(600); // шрифти
    const scheme = mode.n.trim();

    const res = await page.evaluate(() => {
      const out = { overflowX: 0, collisions: [], tiny: [], clipped: [], transparentBody: false };

      // Chromium лишає бокси нащадкам закритого <details> (для пошуку по сторінці),
      // тому весь згорнутий вміст лежить в одній точці й дає фальшиві накладання.
      const inClosedDetails = el => {
        const d = el.closest('details');
        return !!d && !d.open && !el.closest('summary');
      };

      // 1. горизонтальний оверфлоу документа
      out.overflowX = document.documentElement.scrollWidth - document.documentElement.clientWidth;

      // Елементи, що вилізли за межі контейнера — з обох боків, і скануємо ВСЕ тіло,
      // а не тільки нащадків .shell: зайвий </div> раніше викидав цілі секції ЗА .shell,
      // і перевірка всередині .shell їх просто не бачила.
      const shell = document.querySelector('.shell').getBoundingClientRect();
      out.escaped = [];
      document.querySelectorAll('body *').forEach(el => {
        if (el.classList.contains('shell') || el.closest('script')) return;
        if (inClosedDetails(el)) return;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return;
        const scrollable = el.closest('.tbl, .mapwrap');
        if (scrollable && scrollable !== el) return; // таблиці й схема скролять усередині — це ок
        const overR = r.right - shell.right;
        const overL = shell.left - r.left;
        if (overR > 1.5) out.clipped.push({ sel: el.className || el.tagName, over: +overR.toFixed(1) });
        if (overL > 1.5) out.escaped.push({ sel: el.className || el.tagName, out: +overL.toFixed(1) });
      });

      // структурний інваріант: усі секції та футер мусять бути всередині .shell
      out.outsideShell = [];
      document.querySelectorAll('section.block, footer').forEach(el => {
        if (!el.closest('.shell')) out.outsideShell.push(el.id || el.tagName);
      });

      // баланс контейнерів: розкладка ламається саме від зайвого </div>
      out.divBalance = null;
      const html = document.documentElement.innerHTML;
      const opens = (html.match(/<div\b/g) || []).length;
      const closes = (html.match(/<\/div>/g) || []).length;
      if (opens !== closes) out.divBalance = `<div>=${opens}, </div>=${closes}`;

      // 2. попарні накладання текстових листків
      const isTextLeaf = el => {
        if (!el.childNodes.length) return false;
        const hasOwnText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 1);
        if (!hasOwnText) return false;
        const cs = getComputedStyle(el);
        return cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0.05;
      };
      const leaves = [...document.querySelectorAll('.shell *')].filter(el => isTextLeaf(el) && !inClosedDetails(el));
      // порядкові фрагменти, не union-rect: інлайн-елемент, перенесений на 2 рядки,
      // має union-прямокутник, що фальшиво «накладається» на сусіда з іншого рядка
      const boxes = [];
      leaves.forEach(el => {
        [...el.getClientRects()].forEach(r => {
          if (r.width > 0 && r.height > 0) boxes.push({ el, r });
        });
      });

      const relatedBy = (a, b) => a.contains(b) || b.contains(a);
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const A = boxes[i], B = boxes[j];
          if (relatedBy(A.el, B.el)) continue;
          const ox = Math.min(A.r.right, B.r.right) - Math.max(A.r.left, B.r.left);
          const oy = Math.min(A.r.bottom, B.r.bottom) - Math.max(A.r.top, B.r.top);
          if (ox > 1.5 && oy > 1.5) {
            out.collisions.push({
              a: (A.el.className || A.el.tagName) + ' :: ' + A.el.textContent.trim().slice(0, 34),
              b: (B.el.className || B.el.tagName) + ' :: ' + B.el.textContent.trim().slice(0, 34),
              ox: +ox.toFixed(1), oy: +oy.toFixed(1),
            });
          }
        }
      }

      // 3. занадто дрібний текст
      document.querySelectorAll('.shell *').forEach(el => {
        const t = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 2);
        if (!t) return;
        if (inClosedDetails(el)) return;
        const fs = parseFloat(getComputedStyle(el).fontSize);
        if (fs < 10.5) out.tiny.push({ sel: el.className || el.tagName, fs });
      });

      // 4. сплющені колонки: елемент вужчий за 40px, але з довгим текстом
      //    (саме так виглядає вертикальний текст «по літері на рядок»)
      out.squeezed = [];
      document.querySelectorAll('.shell *').forEach(el => {
        const txt = [...el.childNodes].filter(n => n.nodeType === 3)
          .map(n => n.textContent.trim()).join('');
        if (txt.length < 9) return;
        if (inClosedDetails(el)) return;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.width < 40) {
          out.squeezed.push({ sel: el.className || el.tagName, w: +r.width.toFixed(1),
            txt: txt.slice(0, 26) });
        }
      });

      // 5. інваріанти схеми зони: 5 станцій, рівні ширини, різні лівi краї
      out.flowBroken = null;
      const st = [...document.querySelectorAll('.station')];
      const hasFlow = st.length > 0 || !!document.querySelector('.mapwrap');
      if (!hasFlow) { /* сторінка без схеми зони — перевірка не застосовується */ }
      else if (st.length !== 5) out.flowBroken = `станцій ${st.length}, а не 5`;
      else {
        const rs = st.map(e => e.getBoundingClientRect());
        const lefts = new Set(rs.map(r => Math.round(r.left)));
        const ws = rs.map(r => r.width);
        const spread = Math.max(...ws) - Math.min(...ws);
        const horizontal = window.innerWidth > 820;
        if (lefts.size !== 5 && horizontal) out.flowBroken = 'станції не в окремих колонках';
        else if (horizontal && spread > 2) out.flowBroken = `ширини колонок різні, розкид ${spread.toFixed(1)}px`;
        else if (!horizontal && lefts.size !== 1) out.flowBroken = 'на вузькому екрані станції не в один стовпець';
      }

      // 6. фокус-панель мусить читатись як окрема плита на будь-якому ґрунті
      out.panelFlat = null;
      const lum = c => {
        const [r, g, b] = c.match(/\d+/g).slice(0, 3).map(Number)
          .map(v => { v /= 255; return v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; });
        return .2126 * r + .7152 * g + .0722 * b;
      };
      const fp = document.querySelector('.focus');
      if (fp) {
        const pl = lum(getComputedStyle(document.body).backgroundColor);
        const fl = lum(getComputedStyle(fp).backgroundColor);
        const ratio = (Math.max(pl, fl) + .05) / (Math.min(pl, fl) + .05);
        // текст панелі проти її ж фону
        const tl = lum(getComputedStyle(fp).color);
        const textRatio = (Math.max(tl, fl) + .05) / (Math.min(tl, fl) + .05);
        if (ratio < 1.12) out.panelFlat = `панель не відрізняється від ґрунту (${ratio.toFixed(2)}:1)`;
        else if (textRatio < 4.5) out.panelFlat = `текст панелі на її фоні ${textRatio.toFixed(1)}:1, треба ≥4.5`;
      }

      // 7. липка смуга мусить мати той самий фон, що й сторінка, у будь-якому
      //    стані теми — інакше на темній сторінці зʼявляється світла плашка
      out.barMismatch = null;
      const bar = document.querySelector('.statusbar');
      if (bar) {
        const bb = getComputedStyle(bar).backgroundColor;
        const pb = getComputedStyle(document.body).backgroundColor;
        if (bb === 'rgba(0, 0, 0, 0)') out.barMismatch = 'фон смуги прозорий';
        else if (bb !== pb) out.barMismatch = `смуга ${bb} проти сторінки ${pb}`;
        // на телефоні смуга не має бути липкою
        const pos = getComputedStyle(bar).position;
        if (window.innerWidth <= 780 && pos === 'sticky') out.barMismatch = 'на вузькому екрані смуга досі sticky';
        // навігація не має розповзатися на другий рядок
        const nav = bar.querySelector('nav');
        const links = [...bar.querySelectorAll('nav a')];
        // нічого не має бути обрізане приховиним скролом
        if (nav && nav.scrollWidth > nav.clientWidth + 1) {
          out.barMismatch = `навігація обрізана: ${nav.scrollWidth} проти ${nav.clientWidth}`;
        }
        // на широкому екрані вона мусить триматися в один рядок
        if (window.innerWidth > 780 && links.length > 1) {
          const tops = new Set(links.map(a => Math.round(a.getBoundingClientRect().top)));
          if (tops.size > 1) out.barMismatch = `навігація в ${tops.size} рядки на широкому екрані`;
        }
      }

      // 8. body має явний фон
      const bodyBg = getComputedStyle(document.body).backgroundColor;
      out.transparentBody = bodyBg === 'rgba(0, 0, 0, 0)' || bodyBg === 'transparent';
      out.bodyBg = bodyBg;

      return out;
    });

    const tag = `${scheme.padEnd(5)} ${vp.n.padEnd(22)}`;
    const bad = res.overflowX > 1 || res.collisions.length || res.clipped.length
      || res.tiny.length || res.transparentBody || res.squeezed.length || res.flowBroken
      || res.panelFlat || res.escaped.length || res.outsideShell.length || res.divBalance
      || res.barMismatch;
    if (bad) problems++;
    console.log(`${bad ? '✗' : '✓'} ${tag} overflowX=${res.overflowX} collisions=${res.collisions.length} clipped=${res.clipped.length} tiny=${res.tiny.length} squeezed=${res.squeezed.length} схема=${res.flowBroken || 'ок'} панель=${res.panelFlat || 'ок'} поза_межами=${res.outsideShell.length} смуга=${res.barMismatch || 'ок'}`);
    if (res.collisions.length) res.collisions.slice(0, 6).forEach(c => console.log(`      ⨯ ${c.a}  ✕  ${c.b}  (${c.ox}×${c.oy}px)`));
    if (res.clipped.length) res.clipped.slice(0, 6).forEach(c => console.log(`      → за межу на ${c.over}px: ${c.sel}`));
    if (res.tiny.length) [...new Set(res.tiny.map(t => `${t.sel} ${t.fs}px`))].slice(0, 5).forEach(t => console.log(`      · дрібно: ${t}`));
    if (res.squeezed.length) res.squeezed.slice(0, 5).forEach(q => console.log(`      ▮ сплющено до ${q.w}px: ${q.sel} «${q.txt}»`));
    if (res.flowBroken) console.log(`      ⚑ схема зони: ${res.flowBroken}`);
    if (res.panelFlat) console.log(`      ◧ фокус-панель: ${res.panelFlat}`);
    if (res.escaped.length) res.escaped.slice(0,5).forEach(e => console.log(`      ← вилізло лівіше контейнера на ${e.out}px: ${e.sel}`));
    if (res.outsideShell.length) console.log(`      ⛔ ПОЗА .shell: ${res.outsideShell.join(', ')}`);
    if (res.divBalance) console.log(`      ⛔ небаланс контейнерів: ${res.divBalance}`);
    if (res.barMismatch) console.log(`      ▬ липка смуга: ${res.barMismatch}`);

    if ((vp.w === 430 || vp.w === 1440) && !mode.stamp) {
      await page.screenshot({ path: `/home/claude/nepal-monitor/shot-${SHOTNAME}-${scheme}-${vp.w}.png`, fullPage: true });
    }
    await ctx.close();
  }
}

await browser.close();
console.log(problems === 0 ? `\nВСЕ ЧИСТО: ${VIEWPORTS.length} ширин × ${MODES.length} станів теми.` : `\nПРОБЛЕМНИХ КОНФІГУРАЦІЙ: ${problems}`);
