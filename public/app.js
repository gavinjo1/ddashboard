import { lineChart, columnChart, barChart, stackedBars, fmt, hideTip, esc } from './charts.js';

const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const GRADE_COLOURS = {
  a:  getComputedStyle(document.documentElement).getPropertyValue('--grade-a').trim(),
  b:  getComputedStyle(document.documentElement).getPropertyValue('--grade-b').trim(),
  bs: getComputedStyle(document.documentElement).getPropertyValue('--grade-bs').trim(),
  rk: getComputedStyle(document.documentElement).getPropertyValue('--grade-rk').trim()
};

/* ------------------------------------------------------------------ *
 * Filter state
 * ------------------------------------------------------------------ */

const state = {
  from: '', to: '',
  shift: [], group: [], type: [], fabric: [], mo: [],
  sort: 'produksi', dir: 'desc',
  dim: 'group',
  search: '',
  tab: 'production'
};

function params() {
  const p = new URLSearchParams();
  if (state.from) p.set('from', state.from);
  if (state.to) p.set('to', state.to);
  for (const k of ['shift', 'group', 'type', 'fabric', 'mo']) {
    if (state[k].length) p.set(k, state[k].join(','));
  }
  return p;
}

/**
 * Every loader is async, so a second call can overtake the first and paint
 * stale data over fresh — clicking the Group/Type toggle while a load is
 * still in flight did exactly that. Each loader takes a ticket and only paints
 * if it is still the most recent caller.
 */
const tickets = {};
const takeTicket = (name) => (tickets[name] = (tickets[name] || 0) + 1);
const isCurrent = (name, ticket) => tickets[name] === ticket;

const api = async (path, extra = {}) => {
  // Query values belong in `extra`; a '?' in the path would produce a second
  // one and the server would read the first parameter with the rest glued on.
  if (path.includes('?')) throw new Error(`api(): pass query values as the second argument, not in "${path}"`);
  const p = params();
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  const res = await fetch(`/api/${path}?${p}`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
};

/* ------------------------------------------------------------------ *
 * Multi-select picker
 * ------------------------------------------------------------------ */

const optValue = (o) => (o && typeof o === 'object' ? o.value : o);
/** Text used for searching — matches the band, the mill's name or the code. */
const optLabel = (o) => (o && typeof o === 'object'
  ? `${o.label ?? ''} ${o.value}` : String(o));
const optShort = (o) => (o && typeof o === 'object' && o.label ? o.label : String(optValue(o)));
/** The TYPE MC code sits under the name, so rows stay one line. */
const optNode = (o) => {
  const wrap = document.createElement('span');
  wrap.className = 'opt';
  if (o && typeof o === 'object' && o.label) {
    wrap.innerHTML = `${esc(o.label)}<small>${esc(o.value)}</small>`;
  } else {
    wrap.textContent = String(optValue(o));
  }
  return wrap;
};

function buildPicker(host, key, options, noun) {
  host.innerHTML = `
    <button class="picker-btn" type="button" aria-haspopup="listbox" aria-expanded="false">
      <span class="val is-empty">All</span><span class="caret">▾</span>
    </button>
    <div class="picker-menu">
      ${options.length > 9 ? '<input type="search" class="search" placeholder="Search…">' : ''}
      <div class="picker-list" role="listbox"></div>
      <div class="picker-foot"><button type="button" data-all>Select all</button><button type="button" data-none>Clear</button></div>
    </div>`;

  const btn = $('.picker-btn', host);
  const list = $('.picker-list', host);
  const label = $('.val', host);

  const paint = () => {
    list.replaceChildren();
    const q = ($('.search', host)?.value || '').toLowerCase();
    for (const opt of options) {
      const value = optValue(opt);
      if (q && !optLabel(opt).toLowerCase().includes(q)) continue;
      const row = document.createElement('label');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = state[key].includes(value);
      box.addEventListener('change', () => {
        state[key] = box.checked
          ? [...state[key], value]
          : state[key].filter((v) => v !== value);
        sync();
        refresh();
      });
      row.append(box, optNode(opt));
      list.append(row);
    }
  };

  const sync = () => {
    const n = state[key].length;
    const one = options.find((o) => optValue(o) === state[key][0]);
    label.textContent = n === 0 ? 'All' : n === 1 ? optShort(one ?? state[key][0]) : `${n} ${noun}`;
    label.classList.toggle('is-empty', n === 0);
    host.classList.toggle('is-set', n > 0);
  };

  btn.addEventListener('click', () => {
    const open = host.classList.contains('is-open');
    $$('.picker.is-open').forEach((p) => p.classList.remove('is-open'));
    host.classList.toggle('is-open', !open);
    btn.setAttribute('aria-expanded', String(!open));
    if (!open) { paint(); $('.search', host)?.focus(); }
  });
  $('.search', host)?.addEventListener('input', paint);
  $('[data-all]', host).addEventListener('click', () => { state[key] = options.map(optValue); sync(); paint(); refresh(); });
  $('[data-none]', host).addEventListener('click', () => { state[key] = []; sync(); paint(); refresh(); });

  host._sync = () => { sync(); paint(); };
  sync();
}

document.addEventListener('click', (e) => {
  if (!e.target.closest('.picker')) $$('.picker.is-open').forEach((p) => p.classList.remove('is-open'));
});

/* ------------------------------------------------------------------ *
 * Stat tiles
 * ------------------------------------------------------------------ */

const tile = (label, value, unit, foot) => `
  <div class="stat">
    <div class="stat-label">${label}</div>
    <div class="stat-value">${value}${unit ? `<span class="unit">${unit}</span>` : ''}</div>
    ${foot ? `<div class="stat-foot">${foot}</div>` : ''}
  </div>`;

/**
 * The words are passed in rather than derived, because "below target" reads as
 * good for a defect rate and bad for an output figure — colour must never be
 * the only thing carrying that distinction.
 */
function statusDot(pct, { good, warn, invert = false, words }) {
  if (pct === null || pct === undefined || isNaN(pct)) return '';
  const ok = invert ? pct <= good : pct >= good;
  const mid = invert ? pct <= warn : pct >= warn;
  const cls = ok ? 'good' : mid ? 'warning' : 'critical';
  const word = ok ? words[0] : mid ? words[1] : words[2];
  return `<span class="dot dot-${cls}" aria-hidden="true"></span>${word}`;
}

async function loadSummary() {
  const ticket = takeTicket('summary');
  const s = await api('summary');
  if (!isCurrent('summary', ticket)) return;
  const perDay = s.days ? s.produksi / s.days : 0;
  const delta = (() => {
    if (!s.prev || !s.prev.days || !s.prev.produksi) return 'No earlier period to compare';
    const prevPerDay = s.prev.produksi / s.prev.days;
    const pc = ((perDay - prevPerDay) / prevPerDay) * 100;
    const up = pc >= 0;
    return `<span class="${up ? 'up' : 'down'}">${up ? '▲' : '▼'} ${fmt.pct(Math.abs(pc))}</span> vs previous ${s.prev.days} days`;
  })();

  $('#stats').innerHTML = [
    tile('Total output', fmt.num(s.produksi), 'm', `${s.days} days · ${s.orders} orders`),
    tile('Average per day', fmt.num(perDay), 'm', delta),
    tile('Machines running', fmt.int(s.machines), '', `${fmt.int(s.entries)} machine-shifts`),
    tile('Stoppages logged', fmt.int(s.stoppages), '',
      s.entries ? `${fmt.pct((s.stoppages / s.entries) * 100)} of shifts` : ''),
    tile('Idle shifts', fmt.int(s.idle_shifts), '', 'Machine-shifts with no output')
  ].join('');
}

/* ------------------------------------------------------------------ *
 * Order detail — only meaningful once the view is narrowed to an order
 * or a fabric, so it stays hidden otherwise
 * ------------------------------------------------------------------ */

async function loadOrderInfo() {
  const card = $('#orderInfo');
  if (!state.mo.length && !state.fabric.length) { card.hidden = true; return; }

  const ticket = takeTicket('orderInfo');
  const rows = await api('order-info');
  if (!isCurrent('orderInfo', ticket)) return;

  card.hidden = rows.length === 0;
  if (!rows.length) return;

  const asOf = [...new Set(rows.map((r) => r.as_of).filter(Boolean))].sort();
  $('#orderInfoSub').textContent = asOf.length
    ? `Order, akumulasi and sisa are the running totals from the daily sheet of ${
        asOf.length > 1 ? `${fmt.day(asOf[0])}–${fmt.day(asOf[asOf.length - 1])}` : fmt.day(asOf[0])
      }. They are not affected by the date filter.`
    : '';

  // One order selected: show how it progressed, day by day.
  await loadOrderHistory(rows.length === 1 ? rows[0] : null);

  $('#orderInfoTable tbody').innerHTML = rows.map((r) => {
    const target = Number(r.total_order) || 0;
    const done = Number(r.akumulasi) || 0;
    // Four orders in the sheet have no quantity entered; a percentage of zero
    // would be meaningless, so the bar is left out rather than faked.
    const pct = target > 0 ? (done / target) * 100 : null;
    const over = pct !== null && pct > 100;
    return `<tr>
      <td class="mc-name">${esc(r.mo)}</td>
      <td>${esc(r.customer ?? '—')}</td>
      <td class="muted">${esc(r.kode_kain ?? '—')}</td>
      <td class="num">${r.pick == null ? '—' : fmt.num(r.pick)}</td>
      <td class="num">${target > 0 ? fmt.num(target) : '—'}</td>
      <td class="num">${fmt.num(done)}</td>
      <td class="num">${r.sisa_order === null ? '—' : fmt.num(r.sisa_order)}</td>
      <td>${pct === null
        ? '<span class="muted">no order qty</span>'
        : `<span class="progress"><span class="progress-track"><span class="progress-fill${
            over ? ' is-over' : ''}" style="width:${Math.min(pct, 100).toFixed(1)}%"></span></span>` +
          `<span class="progress-pct">${fmt.pct(pct)}</span></span>`}</td>
    </tr>`;
  }).join('');
}

async function loadOrderHistory(order) {
  const box = $('#orderHistory');
  if (!order) { box.hidden = true; return; }

  const ticket = takeTicket('orderHistory');
  const rows = await api('order-history', { mo: order.mo });
  if (!isCurrent('orderHistory', ticket)) return;

  box.hidden = rows.length < 2;
  if (rows.length < 2) return;

  const target = Number(order.total_order) || 0;
  $('#orderHistoryTitle').textContent = `Day by day — ${order.mo}`;

  lineChart($('#chartOrderHistory'), rows, {
    y: (d) => Number(d.akumulasi),
    format: fmt.num,
    unit: ' m',
    height: 240,
    baseZero: false,
    reference: target > 0 ? target : null,
    referenceLabel: target > 0 ? `Order ${fmt.num(target)} m` : '',
    tipRows: (d) => [
      ['Output that day', fmt.num(d.produksi) + ' m'],
      ['Akumulasi', fmt.num(d.akumulasi) + ' m'],
      ['Sisa order', fmt.num(d.sisa_order) + ' m']
    ]
  });

  $('#orderHistoryTable tbody').innerHTML = rows.map((r) => {
    const pct = target > 0 ? (Number(r.akumulasi) / target) * 100 : null;
    return `<tr>
      <td>${fmt.day(r.date)}</td>
      <td class="num ${Number(r.produksi) ? '' : 'muted'}">${Number(r.produksi) ? fmt.num(r.produksi) : '—'}</td>
      <td class="num">${fmt.num(r.akumulasi)}</td>
      <td class="num">${fmt.num(r.sisa_order)}</td>
      <td class="num ${pct === null ? 'muted' : ''}">${pct === null ? '—' : fmt.pct(pct)}</td>
    </tr>`;
  }).join('');
}

/* ------------------------------------------------------------------ *
 * Production panel
 * ------------------------------------------------------------------ */

async function loadCharts() {
  const ticket = takeTicket('charts');
  const trend = await api('trend');
  if (!isCurrent('charts', ticket)) return;

  // Discrete daily totals: columns show the day-to-day variation at the bar
  // tops, where a zero-baselined area of a near-flat series shows nothing.
  columnChart($('#chartTrend'), trend, {
    y: (d) => Number(d.produksi),
    format: fmt.int,
    unit: ' m',
    height: 230,
    tipRows: (d) => [
      ['Output', fmt.num(d.produksi) + ' m'],
      ['Machines', fmt.int(d.machines)]
    ]
  });

  const [groups, shifts, stops] = await Promise.all([
    api('breakdown/group'), api('breakdown/shift'), api('stoppages')
  ]);
  if (!isCurrent('charts', ticket)) return;

  // A one-bar bar chart says nothing, so when the chosen dimension collapses
  // to a single row, step down a level rather than draw it.
  let groupRows = state.dim === 'group' ? groups : await api(`breakdown/${state.dim}`);
  let groupTitle = 'Output by';
  if (groupRows.length <= 1) {
    const types = state.dim === 'group' ? await api('breakdown/type') : groupRows;
    if (types.length > 1) {
      groupRows = types;
      groupTitle = 'Output by type';
    } else {
      groupRows = await api('breakdown/machine', { limit: 8 });
      groupTitle = 'Top machines';
    }
  }
  if (!isCurrent('charts', ticket)) return;
  $('#chartGroupTitle').textContent = groupTitle;
  $$('.seg').forEach((b) => b.classList.toggle('is-active', b.dataset.dim === state.dim));

  // 32 fabrics will not fit in this card, so say plainly that it is a top slice
  // rather than letting the chart quietly drop the tail.
  const SHOWN = 8;
  $('#chartGroupNote').textContent = groupRows.length > SHOWN
    ? `Top ${SHOWN} of ${fmt.int(groupRows.length)}, by output`
    : '';

  barChart($('#chartGroup'), groupRows, {
    value: (d) => Number(d.produksi),
    labelWidth: 112,
    tipRows: (d) => [
      ...(d.code ? [['TYPE MC', d.code]] : []),
      ['Output', fmt.num(d.produksi) + ' m'],
      ['Machines', fmt.int(d.machines)]
    ]
  });

  // Shifts read in their own order (A, B, C), not by size.
  barChart($('#chartShift'), [...shifts].sort((a, b) => String(a.label).localeCompare(String(b.label))), {
    value: (d) => Number(d.produksi),
    labelWidth: 56,
    tipRows: (d) => [
      ['Output', fmt.num(d.produksi) + ' m'],
      ['Machine-shifts', fmt.int(d.entries)]
    ]
  });

  barChart($('#chartStop'), stops, {
    value: (d) => Number(d.entries),
    format: fmt.int,
    labelWidth: 108,
    tipRows: (d) => [
      ['Shifts affected', fmt.int(d.entries)],
      ['Machines', fmt.int(d.machines)],
      ['Output those shifts', fmt.num(d.produksi) + ' m']
    ]
  });
}

let machineRows = [];

async function loadMachines() {
  const ticket = takeTicket('machines');
  const rows = await api('machines', { sort: state.sort, dir: state.dir });
  if (!isCurrent('machines', ticket)) return;
  machineRows = rows;
  paintMachines();
}

function paintMachines() {
  const q = state.search.toLowerCase();
  const shown = machineRows.filter((r) => !q
    || r.machine.toLowerCase().includes(q)
    || (r.grp || '').toLowerCase().includes(q)
    || (r.type_name || '').toLowerCase().includes(q));
  const top = Math.max(...shown.map((r) => Number(r.produksi) || 0), 1);

  $('#machineTable tbody').innerHTML = shown.map((r) => {
    const width = (Number(r.produksi) / top) * 54;
    return `<tr tabindex="0" data-mc="${esc(r.machine)}">
      <td class="mc-name">${esc(r.machine)}</td>
      <td>${esc(r.type_name ?? '—')}</td>
      <td class="muted">${esc(r.grp ?? '—')}</td>
      <td class="num"><span class="cell-bar"><i style="width:${width.toFixed(1)}px"></i>${fmt.num(r.produksi)}</span></td>
      <td class="num">${fmt.num(r.avg_day)}</td>
      <td class="num">${fmt.num(r.avg_rpm)}</td>
      <td class="num">${r.stoppages || '—'}</td>
      <td class="num">${r.idle || '—'}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="8" class="muted" style="padding:20px;text-align:center">No machines match.</td></tr>`;
}

async function openMachine(no) {
  const rows = await api(`machine/${encodeURIComponent(no)}`);
  const meta = machineRows.find((r) => r.machine === no);
  $('#drawerTitle').textContent =
    `Machine ${no}${meta?.type_name ? ` · ${meta.type_name}` : ''} — ${rows.length} shifts`;
  $('#drawerTable tbody').innerHTML = rows.map((r) => `
    <tr>
      <td>${esc(fmt.day(r.date))}</td>
      <td>${esc(r.shift)}</td>
      <td class="muted">${esc(r.mo ?? '—')}</td>
      <td class="muted">${esc(r.kode_kain ?? '—')}</td>
      <td class="num">${r.pick == null ? '—' : fmt.num(r.pick)}</td>
      <td class="num">${fmt.num(r.rpm)}</td>
      <td class="num">${fmt.num(r.rpm_target)}</td>
      <td class="num">${fmt.num(r.produksi)}</td>
      <td>${esc(r.ket_bb ?? '')}</td>
    </tr>`).join('');
  $('#drawer').showModal();
}

/* ------------------------------------------------------------------ *
 * Quality panel
 * ------------------------------------------------------------------ */

async function loadQuality() {
  const ticket = takeTicket('quality');
  const { totals, daily, byFabric } = await api('quality');
  if (!isCurrent('quality', ticket)) return;
  const total = Number(totals.total) || 0;
  const defect = Number(totals.bs) + Number(totals.rk);
  const rate = total ? (defect / total) * 100 : null;

  $('#qStats').innerHTML = [
    tile('Inspected', fmt.num(total), 'm', `${totals.rows} order-days`),
    tile('Grade A', fmt.pct(total ? (Number(totals.a) / total) * 100 : null), '', `${fmt.num(totals.a)} m`),
    tile('Grade B', fmt.pct(total ? (Number(totals.b) / total) * 100 : null), '', `${fmt.num(totals.b)} m`),
    tile('Defect rate', fmt.pct(rate), '',
      statusDot(rate, { good: 1, warn: 2.5, invert: true, words: ['Low', 'Elevated', 'High'] })),
    tile('Bad stock', fmt.num(totals.bs), 'm', 'BS'),
    tile('Reject', fmt.num(totals.rk), 'm', 'RK')
  ].join('');

  stackedBars($('#chartQuality'), daily, [
    { name: 'Grade A', colour: GRADE_COLOURS.a,  value: (d) => Number(d.a) },
    { name: 'Grade B', colour: GRADE_COLOURS.b,  value: (d) => Number(d.b) },
    { name: 'Bad stock', colour: GRADE_COLOURS.bs, value: (d) => Number(d.bs) },
    { name: 'Reject', colour: GRADE_COLOURS.rk, value: (d) => Number(d.rk) }
  ]);

  $('#qFabricTable tbody').innerHTML = byFabric.map((r) => {
    const t = Number(r.total) || 0;
    return `<tr>
      <td>${esc(r.label)}</td>
      <td class="num">${fmt.num(t)}</td>
      <td class="num">${fmt.pct(t ? (Number(r.a) / t) * 100 : null)}</td>
      <td class="num">${fmt.pct(t ? (Number(r.defect) / t) * 100 : null)}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="4" class="muted" style="padding:20px;text-align:center">No grade data.</td></tr>`;

  // The table view is the relief for the light segment colours in the stack.
  $('#qDailyTable tbody').innerHTML = daily.map((r) => {
    const t = Number(r.total) || 0;
    return `<tr>
      <td>${fmt.day(r.date)}</td>
      <td class="num">${fmt.num(r.a)}</td>
      <td class="num">${fmt.num(r.b)}</td>
      <td class="num">${fmt.num(r.bs)}</td>
      <td class="num">${fmt.num(r.rk)}</td>
      <td class="num">${fmt.num(t)}</td>
      <td class="num">${fmt.pct(t ? ((Number(r.bs) + Number(r.rk)) / t) * 100 : null)}</td>
    </tr>`;
  }).join('') || `<tr><td colspan="7" class="muted" style="padding:20px;text-align:center">No grade data.</td></tr>`;
}

/* ------------------------------------------------------------------ *
 * Import panel
 * ------------------------------------------------------------------ */

async function loadImportLog() {
  const rows = await fetch('/api/imports').then((r) => r.json());
  $('#importLog tbody').innerHTML = rows.map((r) => `
    <tr>
      <td class="muted nowrap">${esc(r.at)}</td>
      <td>${esc(r.file_name)}</td>
      <td class="muted">${esc(r.sheet_name ?? '—')}</td>
      <td class="num">${fmt.int(r.rows_written)}</td>
      <td class="num">${r.rows_skipped || '—'}</td>
      <td><span class="pill pill-${r.status === 'ok' ? 'ok' : 'err'}">${esc(r.status)}</span>${r.message ? ` <span class="muted">${esc(r.message)}</span>` : ''}</td>
    </tr>`).join('') || `<tr><td colspan="6" class="muted" style="padding:20px;text-align:center">Nothing imported yet.</td></tr>`;
}

async function uploadFile(file) {
  const drop = $('#drop');
  const out = $('#importResult');
  drop.classList.add('is-busy');
  out.innerHTML = `<div class="result result-ok">Reading ${esc(file.name)}…</div>`;

  const body = new FormData();
  body.append('file', file);

  try {
    const res = await fetch('/api/import', { method: 'POST', body });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Import failed');

    const ok = data.results.filter((r) => r.status === 'ok');
    const bad = data.results.filter((r) => r.status !== 'ok');
    const added = ok.reduce((t, r) => t + (r.inserted ?? 0), 0);
    const changed = ok.reduce((t, r) => t + (r.updated ?? 0), 0);

    out.innerHTML = `
      <div class="result ${bad.length ? 'result-err' : 'result-ok'}">
        <div class="result-title">${fmt.int(added)} new rows, ${fmt.int(changed)} updated — from ${esc(data.file)}</div>
        <ul>
          ${data.results.map((r) => r.status === 'ok'
            ? `<li><strong>${esc(r.sheet)}</strong> — ${esc(r.dataset)}: ${fmt.int(r.inserted ?? 0)} new, ${fmt.int(r.updated ?? 0)} updated, ${r.skipped} skipped${r.duplicates ? `, ${r.duplicates} duplicate keys collapsed` : ''}</li>`
            : `<li><strong>${esc(r.sheet)}</strong> — ${esc(r.message)}</li>`).join('')}
        </ul>
      </div>`;

    await Promise.all([loadFilters(), loadImportLog()]);
    await refresh();
  } catch (err) {
    out.innerHTML = `<div class="result result-err"><div class="result-title">Could not import ${esc(file.name)}</div><p>${esc(err.message)}</p></div>`;
  } finally {
    drop.classList.remove('is-busy');
  }
}

/* ------------------------------------------------------------------ *
 * Search over everything
 *
 * Whatever you type — a customer, an order, a fabric, a machine, a stoppage
 * note — the answer comes back as a list of orders, because that is the level
 * the mill plans and ships at.
 * ------------------------------------------------------------------ */

const gsPanel = $('#gsPanel');
const gsInput = $('#gsInput');

const closeSearch = () => {
  gsPanel.hidden = true;
  gsInput.setAttribute('aria-expanded', 'false');
};

function renderSearch(query, rows) {
  $('#gsStatus').textContent = rows.length
    ? `${fmt.int(rows.length)} order for "${query}"`
    : `Nothing matches "${query}"`;

  // An order can run on five machine types across nineteen looms; listing them
  // all fills the line and truncates before anything useful is visible.
  const summarise = (value, sep, noun) => {
    if (!value) return null;
    const parts = value.split(sep).map((v) => v.trim()).filter(Boolean);
    if (!parts.length) return null;
    return parts.length === 1 ? parts[0] : `${parts[0]} +${parts.length - 1} ${noun}`;
  };

  $('#gsList').innerHTML = rows.map((r) => {
    const bits = [
      summarise(r.kode_kain, ',', 'fabric'),
      summarise(r.type_mc, '·', 'type'),
      r.n_machines ? `${fmt.int(r.n_machines)} machines` : null
    ].filter(Boolean).join(' · ');
    return `<button class="gs-row" type="button" data-mo="${esc(r.mo)}">
      <span class="gs-main">
        <span><span class="gs-mo">${esc(r.mo)}</span><span class="gs-cust">${esc(r.customer ?? '—')}</span></span>
        <span class="gs-sub">${esc(bits) || 'not woven in this period'}</span>
      </span>
      <span class="gs-right">
        <span class="gs-prod">${r.produksi === null ? '—' : fmt.num(r.produksi) + ' m'}</span><br>
        <span class="gs-tag">${esc(r.matched ?? 'match')}</span>
      </span>
    </button>`;
  }).join('');

  gsPanel.hidden = false;
  gsInput.setAttribute('aria-expanded', 'true');
}

let gsTimer = null;
gsInput.addEventListener('input', () => {
  clearTimeout(gsTimer);
  const query = gsInput.value.trim();
  if (query.length < 2) { closeSearch(); return; }

  gsTimer = setTimeout(async () => {
    const ticket = takeTicket('search');
    const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
    const data = await res.json();
    if (!isCurrent('search', ticket)) return;
    renderSearch(data.query, data.rows);
  }, 180);
});

gsInput.addEventListener('focus', () => {
  if (gsInput.value.trim().length >= 2 && $('#gsList').children.length) gsPanel.hidden = false;
});

/** Picking an order narrows the whole dashboard to it. */
$('#gsList').addEventListener('click', async (e) => {
  const row = e.target.closest('.gs-row');
  if (!row) return;
  state.mo = [row.dataset.mo];
  $$('.picker').forEach((p) => p._sync?.());
  closeSearch();
  gsInput.value = '';
  if (state.tab !== 'production') switchTab('production'); else await refresh();
});

document.addEventListener('click', (e) => { if (!e.target.closest('.gsearch')) closeSearch(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSearch(); });

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

async function loadFilters() {
  const f = await fetch('/api/filters').then((r) => r.json());

  $('#dataRange').textContent = f.range.total
    ? `${f.range.min_date} → ${f.range.max_date} · ${fmt.int(f.range.total)} machine-shifts`
    : 'No data yet — start on the Import tab';

  if (!state.from && f.range.min_date) {
    state.from = f.range.min_date;
    state.to = f.range.max_date;
    $('#fFrom').value = state.from;
    $('#fTo').value = state.to;
  }
  $('#fFrom').min = $('#fTo').min = f.range.min_date || '';
  $('#fFrom').max = $('#fTo').max = f.range.max_date || '';

  buildPicker($('#pShift'),  'shift',  f.shifts,   'shifts');
  buildPicker($('#pGroup'),  'group',  f.groups,   'groups');
  buildPicker($('#pType'),   'type',   f.types,    'types');
  buildPicker($('#pFabric'), 'fabric', f.fabrics,  'fabrics');
  buildPicker($('#pMo'),     'mo',     f.mos,      'orders');
}

async function refresh() {
  $('#btnExport').href = `/api/export.csv?${params()}`;
  syncFilterSummary();
  if (state.tab === 'production') {
    await Promise.all([loadSummary(), loadCharts(), loadMachines(), loadOrderInfo()]);
  } else if (state.tab === 'quality') {
    await loadQuality();
  } else {
    await loadImportLog();
  }
}

/** On small screens the filters fold away; the button carries a summary. */
function syncFilterSummary() {
  const picked = ['shift', 'group', 'type', 'fabric', 'mo']
    .reduce((n, k) => n + state[k].length, 0);
  const range = state.from && state.to ? `${fmt.day(state.from)} – ${fmt.day(state.to)}` : '';
  $('#filtersSummary').textContent =
    [range, picked ? `${picked} selected` : ''].filter(Boolean).join(' · ');
}

$('#filtersToggle').addEventListener('click', () => {
  const open = $('#filterBar').classList.toggle('is-open');
  $('#filtersToggle').setAttribute('aria-expanded', String(open));
});

function switchTab(name) {
  state.tab = name;
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === name));
  $$('.panel').forEach((p) => p.classList.toggle('is-active', p.id === `panel-${name}`));
  // Machine-level filters mean nothing on the import screen.
  $('#filterBar').classList.toggle('is-hidden', name === 'import');
  $$('.field[data-pick]').forEach((f) => {
    const onlyOrderFilters = name === 'quality';
    f.style.display = onlyOrderFilters && !['fabric', 'mo'].includes(f.dataset.pick) ? 'none' : '';
  });
  refresh();
}

$$('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

$$('.seg').forEach((b) => b.addEventListener('click', () => {
  state.dim = b.dataset.dim;
  loadCharts();
}));

$('#fFrom').addEventListener('change', (e) => { state.from = e.target.value; refresh(); });
$('#fTo').addEventListener('change', (e) => { state.to = e.target.value; refresh(); });

$('#btnReset').addEventListener('click', async () => {
  for (const k of ['shift', 'group', 'type', 'fabric', 'mo']) state[k] = [];
  state.from = state.to = '';
  state.search = '';
  $('#mcSearch').value = '';
  await loadFilters();
  $$('.picker').forEach((p) => p._sync?.());
  refresh();
});

$('#mcSearch').addEventListener('input', (e) => { state.search = e.target.value; paintMachines(); });


$$('#machineTable th.sortable').forEach((th) => th.addEventListener('click', () => {
  const key = th.dataset.sort;
  state.dir = state.sort === key && state.dir === 'desc' ? 'asc' : 'desc';
  state.sort = key;
  $$('#machineTable th').forEach((h) => h.classList.remove('is-sorted-asc', 'is-sorted-desc'));
  th.classList.add(state.dir === 'asc' ? 'is-sorted-asc' : 'is-sorted-desc');
  loadMachines();
}));

$('#machineTable tbody').addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-mc]');
  if (row) openMachine(row.dataset.mc);
});
$('#machineTable tbody').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const row = e.target.closest('tr[data-mc]');
  if (row) openMachine(row.dataset.mc);
});
$('#drawerClose').addEventListener('click', () => $('#drawer').close());

const drop = $('#drop');
$('#browse').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => {
  if (e.target.files[0]) uploadFile(e.target.files[0]);
  e.target.value = '';
});
['dragenter', 'dragover'].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('is-over'); }));
['dragleave', 'drop'].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('is-over'); }));
drop.addEventListener('drop', (e) => {
  const file = e.dataTransfer.files[0];
  if (file) uploadFile(file);
});

window.addEventListener('scroll', hideTip, { passive: true });

await loadFilters();
switchTab('production');
