/* ------------------------------------------------------------------ *
 * Small SVG chart set. Everything is drawn at the container's real pixel
 * width and redrawn on resize, so text never scales with a viewBox.
 * ------------------------------------------------------------------ */

const NS = 'http://www.w3.org/2000/svg';
const tip = () => document.getElementById('tooltip');

/**
 * Everything that reaches a chart label or tooltip came out of a spreadsheet
 * cell, and a cell can hold "<img src=x onerror=...>". Anything interpolated
 * into innerHTML goes through this first.
 */
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Indonesian convention throughout: "." groups thousands, "," is the decimal
// point, so 2019419.4 reads 2.019.419,4 — the same way the source workbook does.
const LOCALE = 'id-ID';
const blank = (n) => n === null || n === undefined || n === '' || isNaN(n);

export const fmt = {
  /** Measurements — metres, RPM, grades. Keeps the decimals the data has. */
  num:  (n) => (blank(n) ? '—' : Number(n).toLocaleString(LOCALE, { maximumFractionDigits: 2 })),
  /** Counts — machines, shifts, orders. Never fractional. */
  int:  (n) => (blank(n) ? '—' : Math.round(n).toLocaleString(LOCALE)),
  one:  (n) => (blank(n) ? '—' : Number(n).toLocaleString(LOCALE, { maximumFractionDigits: 1 })),
  pct:  (n) => (blank(n) ? '—' : Number(n).toLocaleString(LOCALE, { maximumFractionDigits: 1 }) + '%'),
  /** 1,2rb / 340rb / 2M — axis ticks only, never a figure the reader must trust. */
  short: (n) => {
    const a = Math.abs(n);
    if (a >= 1e6) return (n / 1e6).toLocaleString(LOCALE, { maximumFractionDigits: 1 }) + 'M';
    if (a >= 1e3) return (n / 1e3).toLocaleString(LOCALE, { maximumFractionDigits: a >= 1e5 ? 0 : 1 }) + 'rb';
    return fmt.int(n);
  },
  day: (iso) => {
    const [, m, d] = iso.split('-');
    return `${Number(d)} ${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][Number(m) - 1]}`;
  }
};

function el(name, attrs = {}, text) {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== null && v !== undefined) node.setAttribute(k, v);
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

/** "Nice" round tick steps, so the axis reads 0 / 200k / 400k rather than 0 / 183k. */
function ticks(max, count = 4) {
  if (!(max > 0)) return [0, 1];
  const rough = max / count;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * mag >= rough) * mag;
  const out = [];
  // Run past max, not up to it: the top tick must sit at or above the tallest mark.
  for (let v = 0; ; v += step) {
    out.push(Number(v.toFixed(10)));
    if (v >= max) break;
  }
  return out;
}

/** Round ticks for a domain that does not start at zero (rates, percentages). */
function ticksBetween(lo, hi, count = 4) {
  const span = hi - lo || 1;
  const mag = 10 ** Math.floor(Math.log10(span / count));
  const step = [1, 2, 2.5, 5, 10].find((m) => m * mag >= span / count) * mag;
  const first = Math.ceil(lo / step) * step;
  const out = [];
  for (let v = first; v <= hi + step / 1e6; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

/** Indices to label, walking back from the last point so it is always shown. */
function labelIndices(n, every) {
  const keep = new Set();
  for (let i = n - 1; i >= 0; i -= every) keep.add(i);
  return keep;
}

/**
 * Real text widths, so label and value columns fit what is actually drawn
 * rather than a guess at average character width. Cached per font.
 */
const measurers = new Map();
function measurer(font) {
  if (!measurers.has(font)) {
    const ctx = document.createElement('canvas').getContext('2d');
    ctx.font = font;
    measurers.set(font, (t) => ctx.measureText(String(t)).width);
  }
  return measurers.get(font);
}

const UI_FONT = 'system-ui, -apple-system, "Segoe UI", sans-serif';

/** Shortens `text` with an ellipsis until it fits `maxWidth`. */
function ellipsize(text, maxWidth, measure) {
  if (measure(text) <= maxWidth) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(text.slice(0, mid) + '…') <= maxWidth) lo = mid; else hi = mid - 1;
  }
  return text.slice(0, lo) + '…';
}

function mount(host, render) {
  const draw = () => {
    const w = host.clientWidth;
    if (w > 0) { host.replaceChildren(); render(host, w); }
  };
  if (host._ro) host._ro.disconnect();
  host._ro = new ResizeObserver(draw);
  host._ro.observe(host);
  draw();
}

function empty(host, msg = 'No data for this selection.') {
  // Drop the previous render's observer first. Without this it survives the
  // emptying and redraws the OLD data on the next layout change, so a card
  // with nothing to show silently comes back with stale numbers.
  if (host._ro) { host._ro.disconnect(); host._ro = null; }
  const p = document.createElement('p');
  p.className = 'empty';
  p.textContent = msg;
  host.replaceChildren(p);
}

/* ---- tooltip plumbing ---- */

function showTip(evt, html) {
  const t = tip();
  t.innerHTML = html;
  t.hidden = false;
  const r = t.getBoundingClientRect();
  const x = Math.min(evt.clientX + 14, window.innerWidth - r.width - 8);
  const y = Math.max(8, evt.clientY - r.height - 12);
  t.style.left = `${x}px`;
  t.style.top = `${y}px`;
}
export const hideTip = () => { tip().hidden = true; };

const rows = (pairs) => pairs
  .map(([k, v, colour]) =>
    `<div class="row"><span>${colour ? `<i class="swatch" style="color:${esc(colour)}"></i>` : ''}${esc(k)}</span><span>${esc(v)}</span></div>`)
  .join('');

/* ------------------------------------------------------------------ *
 * Line / area — one series, one axis
 * ------------------------------------------------------------------ */

export function lineChart(host, data, {
  x = (d) => d.date,
  y = (d) => d.value,
  format = fmt.num,
  unit = '',
  height = 210,
  colour = 'var(--series-1)',
  fill = 'var(--series-1-fill)',
  tipRows = null,
  baseZero = true,
  reference = null,          // { value, label } — kept inside the domain
  referenceLabel = ''
} = {}) {
  const pts = data.filter((d) => y(d) !== null && y(d) !== undefined && !isNaN(y(d)));
  if (pts.length < 2) return empty(host, pts.length ? 'Only one day in range.' : undefined);

  mount(host, (root, w) => {
    // The endpoint carries a direct label, so reserve exactly its width —
    // a fixed margin clips "56.160,4 m" while wasting space on "98,3%".
    const measureLabel = measurer(`11.5px ${UI_FONT}`);
    const measureAxis = measurer(`11px ${UI_FONT}`);
    const endLabel = format(y(pts[pts.length - 1])) + unit;

    const vals = pts.map(y);
    // A target line only tells you anything if it is inside the plotted range.
    const rawMin = Math.min(...vals, reference ?? Infinity);
    const rawMax = Math.max(...vals, reference ?? -Infinity);
    const span = rawMax - rawMin || Math.abs(rawMax) * 0.02 || 1;
    const lo = baseZero ? 0 : rawMin - span * 0.35;
    const tk = baseZero ? ticks(rawMax) : null;
    const top = baseZero ? tk[tk.length - 1] : rawMax + span * 0.3;

    // Both margins are sized from the text that actually goes in them: a fixed
    // left margin clips "300.000" and a fixed right one clips "56.160,4 m".
    const axisTexts = (tk || ticksBetween(lo, top)).map((v) => (baseZero ? fmt.short(v) : format(v)));
    const m = {
      t: 14,
      r: Math.ceil(measureLabel(endLabel)) + 18,
      b: 26,
      l: Math.ceil(Math.max(...axisTexts.map(measureAxis))) + 12
    };
    const iw = Math.max(40, w - m.l - m.r);
    const ih = height - m.t - m.b;

    const scaleY = (v) => m.t + ih - ((v - lo) / (top - lo || 1)) * ih;
    const scaleX = (i) => m.l + (pts.length === 1 ? iw / 2 : (i / (pts.length - 1)) * iw);

    const svg = el('svg', { width: w, height, role: 'img' });

    // recessive solid hairline grid
    for (const v of (tk || ticksBetween(lo, top))) {
      const gy = scaleY(v);
      if (gy < m.t - 1 || gy > m.t + ih + 1) continue;
      svg.append(el('line', { class: v === lo && baseZero ? 'axis-line' : 'grid-line', x1: m.l, x2: m.l + iw, y1: gy, y2: gy }));
      svg.append(el('text', { class: 'axis-label num', x: m.l - 8, y: gy + 4, 'text-anchor': 'end' },
        baseZero ? fmt.short(v) : format(v)));
    }

    if (reference !== null) {
      const ry = scaleY(reference);
      svg.append(el('line', { x1: m.l, x2: m.l + iw, y1: ry, y2: ry, stroke: 'var(--axis)', 'stroke-width': 1 }));
      svg.append(el('text', { class: 'axis-label', x: m.l + iw, y: ry - 6, 'text-anchor': 'end' }, referenceLabel));
    }

    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${scaleX(i).toFixed(1)},${scaleY(y(p)).toFixed(1)}`).join(' ');
    svg.append(el('path', {
      d: `${d} L${scaleX(pts.length - 1).toFixed(1)},${m.t + ih} L${scaleX(0).toFixed(1)},${m.t + ih} Z`,
      fill, stroke: 'none'
    }));
    svg.append(el('path', { d, fill: 'none', stroke: colour, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));

    // x labels thinned to whatever fits
    const keep = labelIndices(pts.length, Math.max(1, Math.ceil(pts.length / Math.floor(iw / 58))));
    pts.forEach((p, i) => {
      if (!keep.has(i)) return;
      svg.append(el('text', { class: 'axis-label', x: scaleX(i), y: height - 8, 'text-anchor': 'middle' }, fmt.day(x(p))));
    });

    // direct-label the endpoint only
    const last = pts.length - 1;
    const lx = scaleX(last), ly = scaleY(y(pts[last]));
    svg.append(el('circle', { cx: lx, cy: ly, r: 4.5, fill: colour, stroke: 'var(--surface)', 'stroke-width': 2 }));
    svg.append(el('text', { class: 'point-label', x: lx + 8, y: ly + 4 }, endLabel));

    // crosshair
    const hair = el('line', { class: 'axis-line', y1: m.t, y2: m.t + ih, opacity: 0 });
    const dot = el('circle', { r: 4.5, fill: colour, stroke: 'var(--surface)', 'stroke-width': 2, opacity: 0 });
    svg.append(hair, dot);

    const surface = el('rect', { x: m.l, y: m.t, width: iw, height: ih, fill: 'transparent' });
    surface.addEventListener('pointermove', (e) => {
      const bounds = svg.getBoundingClientRect();
      const i = Math.max(0, Math.min(pts.length - 1,
        Math.round(((e.clientX - bounds.left - m.l) / iw) * (pts.length - 1))));
      const px = scaleX(i), py = scaleY(y(pts[i]));
      hair.setAttribute('x1', px); hair.setAttribute('x2', px); hair.setAttribute('opacity', 1);
      dot.setAttribute('cx', px); dot.setAttribute('cy', py); dot.setAttribute('opacity', 1);
      showTip(e, `<b>${esc(fmt.day(x(pts[i])))}</b>${rows(tipRows ? tipRows(pts[i]) : [['Value', format(y(pts[i])) + unit]])}`);
    });
    surface.addEventListener('pointerleave', () => {
      hair.setAttribute('opacity', 0); dot.setAttribute('opacity', 0); hideTip();
    });
    svg.append(surface);

    root.append(svg);
  });
}

/* ------------------------------------------------------------------ *
 * Horizontal bars — one measure, nominal categories, one colour
 * ------------------------------------------------------------------ */

export function barChart(host, data, {
  label = (d) => d.label,
  value = (d) => d.value,
  format = fmt.num,
  labelWidth = 110,
  rowHeight = 27,
  tipRows = null,
  max = 8
} = {}) {
  const rowsIn = data.filter((d) => value(d) > 0).slice(0, max);
  if (!rowsIn.length) return empty(host);

  mount(host, (root, w) => {
    const pad = { t: 4, r: 8, b: 4 };
    const gap = 7;                        // >= 2px surface gap between bars
    const barH = rowHeight - gap;

    const measureLabel = measurer(`11px ${UI_FONT}`);
    const measureValue = measurer(`11.5px ${UI_FONT}`);
    const names = rowsIn.map((d) => String(label(d) ?? '—'));
    const texts = rowsIn.map((d) => format(value(d)));

    const wantLabel = Math.max(...names.map(measureLabel)) + 10;
    const valueW = Math.max(...texts.map(measureValue)) + 14;

    // Names like "AJL TOYOTA 2 810 | AJL 2 AIR TUCKER" do not fit beside a bar
    // in a narrow card. When they don't, the label moves onto its own line
    // above a full-width bar rather than being cut where it matters.
    const inlineLabelW = Math.max(labelWidth, wantLabel);
    const stacked = inlineLabelW > (w - valueW) * 0.45;

    const top = Math.max(...rowsIn.map(value));
    const step = stacked ? rowHeight + 15 : rowHeight;
    const trackW = stacked ? w - pad.r : Math.max(30, w - inlineLabelW - valueW - pad.r);
    const total = pad.t + rowsIn.length * step + pad.b;

    const svg = el('svg', { width: w, height: total, role: 'img' });

    rowsIn.forEach((d, i) => {
      const y = pad.t + i * step;
      const bw = Math.max(2, (value(d) / top) * trackW);
      const g = el('g', { class: 'bar-row' });
      const name = names[i];

      const barY = stacked ? y + 16 : y;
      const barX = stacked ? 0 : inlineLabelW;
      const barHeight = stacked ? 7 : barH;
      const textY = stacked ? y + 10 : y + barH / 2 + 4;

      const text = el('text', { class: 'axis-label', x: 0, y: textY },
        stacked ? ellipsize(name, w - valueW - 8, measureLabel)
                : ellipsize(name, inlineLabelW - 10, measureLabel));
      text.append(el('title', {}, name));   // full name on hover

      g.append(
        text,
        // 4px rounded data-end, anchored square to the baseline
        el('rect', { class: 'bar', x: barX, y: barY, width: bw, height: barHeight, rx: 3 }),
        el('text', { class: 'bar-value', x: w - pad.r, y: textY, 'text-anchor': 'end' }, texts[i])
      );

      const hit = el('rect', { class: 'bar-hit', x: 0, y: y - gap / 2, width: w, height: step });
      hit.addEventListener('pointermove', (e) =>
        showTip(e, `<b>${esc(name)}</b>${rows(tipRows ? tipRows(d) : [['Value', format(value(d))]])}`));
      hit.addEventListener('pointerleave', hideTip);
      g.append(hit);

      svg.append(g);
    });

    root.append(svg);
  });
}

/* ------------------------------------------------------------------ *
 * Stacked bars — ordered grades, legend always present
 * ------------------------------------------------------------------ */

export function stackedBars(host, data, series, {
  x = (d) => d.date,
  height = 230,
  format = fmt.num
} = {}) {
  const pts = data.filter((d) => series.some((s) => s.value(d) > 0));
  if (!pts.length) return empty(host);

  mount(host, (root, w) => {
    const m = { t: 14, r: 10, b: 26, l: 48 };
    const iw = Math.max(40, w - m.l - m.r);
    const ih = height - m.t - m.b;
    const totals = pts.map((d) => series.reduce((s, ser) => s + (ser.value(d) || 0), 0));
    const tk = ticks(Math.max(...totals));
    const top = tk[tk.length - 1];
    const scaleY = (v) => m.t + ih - (v / (top || 1)) * ih;

    const slot = iw / pts.length;
    const barW = Math.max(3, Math.min(22, slot - 8));

    const svg = el('svg', { width: w, height, role: 'img' });

    for (const v of tk) {
      const gy = scaleY(v);
      svg.append(el('line', { class: v === 0 ? 'axis-line' : 'grid-line', x1: m.l, x2: m.l + iw, y1: gy, y2: gy }));
      svg.append(el('text', { class: 'axis-label num', x: m.l - 8, y: gy + 4, 'text-anchor': 'end' }, fmt.short(v)));
    }

    const keep = labelIndices(pts.length, Math.max(1, Math.ceil(pts.length / Math.floor(iw / 58))));

    pts.forEach((d, i) => {
      const cx = m.l + slot * i + slot / 2;
      let cursor = 0;
      const g = el('g');

      for (const ser of series) {
        const v = ser.value(d) || 0;
        if (v <= 0) { cursor += v; continue; }
        const y0 = scaleY(cursor + v);
        const y1 = scaleY(cursor);
        // 2px surface gap between segments instead of a stroke
        const h = Math.max(1, y1 - y0 - 2);
        g.append(el('rect', { x: cx - barW / 2, y: y0, width: barW, height: h, fill: ser.colour, rx: 1.5 }));
        cursor += v;
      }

      const hit = el('rect', { x: cx - slot / 2, y: m.t, width: slot, height: ih, fill: 'transparent' });
      hit.addEventListener('pointermove', (e) => showTip(e,
        `<b>${esc(fmt.day(x(d)))}</b>` +
        rows([...series.map((s) => [s.name, format(s.value(d) || 0), s.colour]),
          ['Total', format(series.reduce((t, s) => t + (s.value(d) || 0), 0))]])));
      hit.addEventListener('pointerleave', hideTip);
      g.append(hit);

      if (keep.has(i)) {
        g.append(el('text', { class: 'axis-label', x: cx, y: height - 8, 'text-anchor': 'middle' }, fmt.day(x(d))));
      }
      svg.append(g);
    });

    root.append(svg);

    const legend = document.createElement('div');
    legend.className = 'legend';
    const grand = series.map((s) => pts.reduce((t, d) => t + (s.value(d) || 0), 0));
    series.forEach((s, i) => {
      const item = document.createElement('span');
      item.innerHTML = `<i style="color:${esc(s.colour)}"></i>${esc(s.name)} <span class="n">${esc(format(grand[i]))}</span>`;
      legend.append(item);
    });
    root.append(legend);
  });
}

/* ------------------------------------------------------------------ *
 * Columns — one measure over discrete days, anchored at zero
 * ------------------------------------------------------------------ */

export function columnChart(host, data, {
  x = (d) => d.date,
  y = (d) => d.value,
  format = fmt.num,
  unit = '',
  height = 230,
  tipRows = null
} = {}) {
  const pts = data.filter((d) => y(d) !== null && !isNaN(y(d)));
  if (!pts.length) return empty(host);

  mount(host, (root, w) => {
    const m = { t: 22, r: 10, b: 26, l: 48 };
    const iw = Math.max(40, w - m.l - m.r);
    const ih = height - m.t - m.b;
    const tk = ticks(Math.max(...pts.map(y)));
    const top = tk[tk.length - 1];
    const scaleY = (v) => m.t + ih - (v / (top || 1)) * ih;

    const slot = iw / pts.length;
    const barW = Math.max(3, Math.min(22, slot - 6));   // >= 2px surface gap
    const svg = el('svg', { width: w, height, role: 'img' });

    for (const v of tk) {
      const gy = scaleY(v);
      svg.append(el('line', { class: v === 0 ? 'axis-line' : 'grid-line', x1: m.l, x2: m.l + iw, y1: gy, y2: gy }));
      svg.append(el('text', { class: 'axis-label num', x: m.l - 8, y: gy + 4, 'text-anchor': 'end' }, fmt.short(v)));
    }

    const keep = labelIndices(pts.length, Math.max(1, Math.ceil(pts.length / Math.floor(iw / 58))));
    const peak = pts.reduce((best, d) => (y(d) > y(best) ? d : best), pts[0]);

    pts.forEach((d, i) => {
      const cx = m.l + slot * i + slot / 2;
      const yTop = scaleY(y(d));
      const g = el('g', { class: 'bar-row' });
      g.append(el('rect', { class: 'bar', x: cx - barW / 2, y: yTop, width: barW, height: Math.max(1, m.t + ih - yTop), rx: 3 }));

      // direct-label the peak only; the axis and tooltip carry the rest
      if (d === peak) {
        g.append(el('text', { class: 'point-label', x: cx, y: yTop - 7, 'text-anchor': 'middle' }, format(y(d)) + unit));
      }

      const hit = el('rect', { x: cx - slot / 2, y: m.t, width: slot, height: ih, fill: 'transparent' });
      hit.addEventListener('pointermove', (e) => showTip(e,
        `<b>${esc(fmt.day(x(d)))}</b>${rows(tipRows ? tipRows(d) : [['Value', format(y(d)) + unit]])}`));
      hit.addEventListener('pointerleave', hideTip);
      g.append(hit);

      if (keep.has(i)) {
        g.append(el('text', { class: 'axis-label', x: cx, y: height - 8, 'text-anchor': 'middle' }, fmt.day(x(d))));
      }
      svg.append(g);
    });

    root.append(svg);
  });
}
