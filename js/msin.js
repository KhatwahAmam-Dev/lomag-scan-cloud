'use strict';
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = n => Number(n || 0).toLocaleString('id-ID');
const nb = s => String(s ?? '').trim().replace(/\s+/g, '');
const stripZ = s => s.replace(/^0+/, '');

/* ---------- Penyimpanan (IndexedDB, cadangan: memori) ---------- */
const DB = {
  db: null, mem: {},
  open() {
    return new Promise(res => {
      try {
        const r = indexedDB.open('opname-scan', 1);
        r.onupgradeneeded = () => r.result.createObjectStore('kv');
        r.onsuccess = () => { this.db = r.result; res(); };
        r.onerror = () => res();
      } catch (e) { res(); }
    });
  },
  get(k) {
    if (!this.db) return Promise.resolve(this.mem[k]);
    return new Promise(res => {
      const q = this.db.transaction('kv').objectStore('kv').get(k);
      q.onsuccess = () => res(q.result);
      q.onerror = () => res(undefined);
    });
  },
  set(k, v) {
    if (!this.db) { this.mem[k] = v; return Promise.resolve(); }
    return new Promise(res => {
      const tx = this.db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(v, k);
      tx.oncomplete = res; tx.onerror = res;
    });
  },
  clear() {
    this.mem = {};
    if (!this.db) return Promise.resolve();
    return new Promise(res => {
      const tx = this.db.transaction('kv', 'readwrite');
      tx.objectStore('kv').clear();
      tx.oncomplete = res; tx.onerror = res;
    });
  }
};

/* ---------- State ---------- */
const S = { master: [], meta: null, extras: [], scans: [], settings: { gh: '', ghAuto: false, sess: '' } };
let all = [], hay = [];
const idx = { bc: new Map(), bcz: new Map(), plu: new Map() };
let card = null;          // {type:'item',key} | {type:'unk',code}
let scanLock = false;

function buildIndex() {
  all = S.master.concat(S.extras);
  idx.bc = new Map(); idx.bcz = new Map(); idx.plu = new Map();
  hay = new Array(all.length);
  all.forEach((p, i) => {
    const b = nb(p.barcode);
    if (b) {
      if (!idx.bc.has(b)) idx.bc.set(b, p);
      const z = stripZ(b);
      if (z && !idx.bcz.has(z)) idx.bcz.set(z, p);
    }
    if (p.plu && !idx.plu.has(p.plu)) idx.plu.set(p.plu, p);
    hay[i] = (p.desc + ' ' + (p.sdesc || '') + ' ' + p.barcode + ' ' + p.plu).toLowerCase();
  });
}
function findProduct(code) {
  const c = nb(code);
  if (!c) return null;
  return idx.bc.get(c) || idx.bcz.get(stripZ(c)) || idx.plu.get(c) || null;
}
function search(q) {
  const t = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!t.length) return [];
  const hit = [];
  for (let i = 0; i < all.length && hit.length < 300; i++) {
    const h = hay[i];
    let ok = true;
    for (const w of t) if (!h.includes(w)) { ok = false; break; }
    if (ok) hit.push([i, all[i].desc.toLowerCase().startsWith(t[0]) ? 0 : 1]);
  }
  hit.sort((a, b) => a[1] - b[1]);
  return hit.slice(0, 30).map(x => all[x[0]]);
}

const saveMaster = () => Promise.all([DB.set('master', S.master), DB.set('meta', S.meta)]);
const saveExtras = () => DB.set('extras', S.extras);
const saveSettings = () => DB.set('settings', S.settings);
let saveT;
const saveScans = () => { clearTimeout(saveT); saveT = setTimeout(() => DB.set('scans', S.scans), 250); };

/* ---------- Umpan balik ---------- */
function toast(msg, kind) {
  const t = $('#toast');
  t.textContent = msg; t.className = 'show ' + (kind || '');
  clearTimeout(toast.t); toast.t = setTimeout(() => t.className = '', 2400);
}
let ac;
function beep(ok = true) {
  try {
    ac = ac || new (window.AudioContext || window.webkitAudioContext)();
    const o = ac.createOscillator(), g = ac.createGain();
    o.frequency.value = ok ? 1200 : 300; g.gain.value = .08;
    o.connect(g); g.connect(ac.destination);
    o.start(); o.stop(ac.currentTime + (ok ? .09 : .25));
  } catch (e) {}
  if (navigator.vibrate) navigator.vibrate(ok ? 30 : [80, 40, 80]);
}
function download(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}
const stamp = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`; };

/* ---------- Parsing master ---------- */
function parseJsonText(t) {
  t = t.trim().replace(/^\uFEFF/, '');
  let data;
  try { data = JSON.parse(t); }
  catch (e) {
    let w = t.replace(/,\s*$/, '');
    if (!w.startsWith('[')) w = '[' + w + ']';
    data = JSON.parse(w);
  }
  if (!Array.isArray(data)) {
    const arr = Object.values(data).find(Array.isArray);
    data = arr || [data];
  }
  return data;
}
function mapRow(r) {
  const o = {};
  for (const k in r) o[k.toLowerCase().trim()] = r[k];
  const s = v => String(v ?? '').trim();
  const barcode = s(o.barcode), plu = s(o.plu);
  const desc = s(o.descp) || s(o.s_descp) || s(o.deskripsi) || s(o.nama);
  if (!barcode && !plu) return null;
  return { plu, desc: desc || '(tanpa nama)', sdesc: s(o.s_descp), barcode: barcode || plu, kat: s(o.kategori), sat: s(o.sat1), price: o.price1 ?? '' };
}
function setMaster(rows, name, source) {
  S.master = rows;
  S.meta = { name, source, at: Date.now() };
  buildIndex(); saveMaster(); renderAll();
}
async function loadFile(file) {
  try {
    let rows;
    const ext = file.name.split('.').pop().toLowerCase();
    if (ext === 'json' || ext === 'txt') {
      rows = parseJsonText(await file.text());
    } else {
      if (!window.XLSX) return toast('Library Excel belum termuat (perlu internet)', 'bad');
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '', raw: false });
    }
    rows = rows.map(mapRow).filter(Boolean);
    if (!rows.length) return toast('Tidak ada baris dengan kolom barcode/plu', 'bad');
    setMaster(rows, file.name, 'File');
    toast(`${fmt(rows.length)} produk dimuat`, 'ok');
  } catch (e) {
    console.error(e);
    toast('File tidak terbaca: ' + (e.message || e), 'bad');
  }
}
function ghRaw(u) {
  u = u.trim();
  const m = u.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/blob\/(.+)$/);
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}` : u;
}
async function loadGh(silent) {
  const url = ghRaw($('#gh').value);
  if (!url) return silent || toast('Isi link file JSON dulu', 'bad');
  S.settings.gh = $('#gh').value.trim(); S.settings.ghAuto = $('#ghAuto').checked; saveSettings();
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const rows = parseJsonText(await r.text()).map(mapRow).filter(Boolean);
    if (!rows.length) throw new Error('data kosong');
    setMaster(rows, url.split('/').pop(), 'GitHub');
    if (!silent) toast(`${fmt(rows.length)} produk dimuat dari GitHub`, 'ok');
  } catch (e) {
    if (!silent) toast('Gagal ambil dari GitHub: ' + (e.message || e), 'bad');
  }
}

/* ---------- Hasil scan ---------- */
function addScan(code, product, delta = 1, manual = false) {
  const barcode = nb(product ? product.barcode : code);
  const key = barcode || (product && product.plu);
  let it = S.scans.find(x => x.key === key);
  if (!it) {
    it = { key, barcode: barcode, plu: product ? product.plu : '', desc: product ? product.desc : '', qty: 0, manual: !!(manual || (product && product.manual)), ts: Date.now(), last: Date.now() };
    S.scans.push(it);
  }
  it.qty = Math.max(0, it.qty + delta);
  it.last = Date.now();
  saveScans();
  return it;
}
function handleCode(code) {
  const c = nb(code);
  if (!c) return;
  const p = findProduct(c);
  if (p) {
    const it = addScan(c, p, 1);
    card = { type: 'item', key: it.key };
    beep(true);
  } else {
    card = { type: 'unk', code: c };
    beep(false);
    toast('Barcode ' + c + ' belum ada di master', 'bad');
  }
  renderCard(); renderList();
}
function pickProduct(p) {
  const it = addScan(p.barcode, p, 1);
  card = { type: 'item', key: it.key };
  $('#q').value = ''; $('#results').innerHTML = '';
  renderCard(); renderList();
}

/* ---------- Render ---------- */
function renderCard() {
  const box = $('#card');
  if (!card) { box.innerHTML = ''; return; }
  if (card.type === 'item') {
    const it = S.scans.find(x => x.key === card.key);
    if (!it) { box.innerHTML = ''; return; }
    box.innerHTML = `<article class="label" data-key="${esc(it.key)}"><div class="label-body">
      <p class="label-desc">${esc(it.desc)}</p>
      <p class="label-line">Barcode ${esc(it.barcode)}</p>
      ${it.plu ? `<p class="label-line">PLU ${esc(it.plu)}</p>` : ''}
      ${it.manual ? '<p class="label-line">Produk manual</p>' : ''}
      <div class="stepper big"><button type="button" data-act="dec" aria-label="Kurangi">−</button><input type="number" inputmode="numeric" min="0" value="${it.qty}" data-act="set" aria-label="Jumlah"><button type="button" data-act="inc" aria-label="Tambah">+</button></div>
    </div></article>`;
  } else {
    const known = card.code ? 'Barcode belum ada di master' : 'Produk manual';
    box.innerHTML = `<article class="label unk"><div class="label-body">
      <p class="label-desc">${known}</p>
      <label class="field">Barcode<input class="in" id="unkCode" inputmode="numeric" value="${esc(card.code || '')}"></label>
      <label class="field">Deskripsi produk<input class="in" id="unkDesc" placeholder="Nama produk"></label>
      <label class="field">Jumlah<input class="in" id="unkQty" type="number" inputmode="numeric" min="0" value="1"></label>
      <div class="row-btns"><button class="btn pri" type="button" data-act="unkSave">Simpan produk manual</button><button class="btn" type="button" data-act="unkCancel">Lewati</button></div>
    </div></article>`;
    if (!card.code) setTimeout(() => { const d = $('#unkDesc'); if (d) d.focus(); }, 30);
  }
}
function renderList() {
  const f = $('#fl').value.toLowerCase().trim();
  const src = S.scans.slice().sort((a, b) => b.last - a.last).filter(x => !f || (x.desc + ' ' + x.barcode + ' ' + x.plu).toLowerCase().includes(f));
  const total = S.scans.reduce((n, x) => n + x.qty, 0);
  $('#sumLines').textContent = fmt(S.scans.length);
  $('#sumQty').textContent = fmt(total);
  $('#cnt').textContent = fmt(S.scans.length);
  const shown = src.slice(0, 300);
  $('#list').innerHTML = shown.length ? shown.map(x => `<li data-key="${esc(x.key)}">
      <div class="info"><b>${esc(x.desc)}${x.manual ? '<span class="tagm">Manual</span>' : ''}</b><small>${esc(x.barcode)}</small></div>
      <div class="stepper"><button type="button" data-act="dec" aria-label="Kurangi">−</button><input type="number" inputmode="numeric" min="0" value="${x.qty}" data-act="set" aria-label="Jumlah"><button type="button" data-act="inc" aria-label="Tambah">+</button></div>
      <button class="del" type="button" data-act="del">Hapus</button></li>`).join('')
    : `<li class="empty">${S.scans.length ? 'Tidak ada yang cocok dengan filter.' : 'Belum ada hasil scan. Mulai dari tab Scan.'}</li>`;
  if (src.length > 300) $('#list').insertAdjacentHTML('beforeend', `<li class="empty">Menampilkan 300 dari ${fmt(src.length)}. Pakai filter untuk mempersempit.</li>`);
  $('#eStat').textContent = S.scans.length ? `${fmt(S.scans.length)} barang, total qty ${fmt(total)}.` : 'Belum ada hasil scan untuk diekspor.';
}
function renderMaster() {
  const n = S.master.length;
  $('#chip').textContent = n ? `Master: ${fmt(n)} produk` : 'Master kosong';
  $('#mStat').textContent = n
    ? `${fmt(n)} produk dari ${S.meta.name} (${S.meta.source}), dimuat ${new Date(S.meta.at).toLocaleString('id-ID')}.`
    : 'Belum ada master. Unggah file atau ambil dari GitHub.';
  $('#xStat').textContent = S.extras.length ? `${fmt(S.extras.length)} produk manual tersimpan di perangkat ini.` : 'Belum ada produk manual.';
  $('#btnXjson').disabled = !S.extras.length;
  $('#gh').value = S.settings.gh || '';
  $('#ghAuto').checked = !!S.settings.ghAuto;
  $('#sess').value = S.settings.sess || '';
}
function renderAll() { renderMaster(); renderList(); renderCard(); }

/* ---------- Aksi (delegasi) ---------- */
function changeQty(key, fn) {
  const it = S.scans.find(x => x.key === key);
  if (!it) return;
  it.qty = Math.max(0, Math.floor(fn(it.qty)) || 0);
  it.last = Date.now();
  saveScans(); renderCard(); renderList();
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-act]');
  if (!b || b.tagName === 'INPUT') return;
  const act = b.dataset.act;
  const key = b.closest('[data-key]')?.dataset.key;
  if (act === 'inc') changeQty(key, q => q + 1);
  else if (act === 'dec') changeQty(key, q => q - 1);
  else if (act === 'del') {
    S.scans = S.scans.filter(x => x.key !== key);
    if (card && card.key === key) card = null;
    saveScans(); renderCard(); renderList();
  }
  else if (act === 'unkCancel') { card = null; scanLock = false; renderCard(); }
  else if (act === 'unkSave') saveManual();
});
document.addEventListener('change', e => {
  const i = e.target;
  if (i.dataset && i.dataset.act === 'set') {
    const key = i.closest('[data-key]')?.dataset.key;
    changeQty(key, () => parseInt(i.value, 10));
  }
});
function saveManual() {
  const code = nb($('#unkCode').value), desc = $('#unkDesc').value.trim(), qty = Math.max(0, parseInt($('#unkQty').value, 10) || 0);
  if (!code) return toast('Barcode wajib diisi', 'bad');
  if (!desc) return toast('Deskripsi wajib diisi', 'bad');
  let p = findProduct(code);
  if (!p) {
    p = { plu: '', desc, sdesc: desc, barcode: code, kat: '', sat: '', price: '', manual: true };
    S.extras.push(p); saveExtras(); buildIndex(); renderMaster();
  } else toast('Barcode sudah ada di master, memakai data master');
  const it = addScan(code, p, 0, !!p.manual);
  it.qty += qty;
  card = { type: 'item', key: it.key };
  scanLock = false; beep(true);
  renderCard(); renderList();
}

/* ---------- Pencarian / input manual ---------- */
let qT;
$('#q').addEventListener('input', () => {
  clearTimeout(qT);
  qT = setTimeout(() => {
    const v = $('#q').value.trim();
    const res = v.length >= 2 ? search(v) : [];
    $('#results').innerHTML = res.map((p, i) => `<li><button type="button" data-i="${i}">${esc(p.desc)}<small>${esc(p.barcode)}</small></button></li>`).join('');
    $('#results')._res = res;
  }, 120);
});
$('#results').addEventListener('click', e => {
  const b = e.target.closest('button[data-i]');
  if (b) pickProduct($('#results')._res[+b.dataset.i]);
});
function submitQuery() {
  const v = $('#q').value.trim();
  if (!v) return;
  if (findProduct(v)) { handleCode(v); $('#q').value = ''; $('#results').innerHTML = ''; return; }
  if (/^\d{6,}$/.test(v)) { handleCode(v); $('#q').value = ''; $('#results').innerHTML = ''; return; }
  const res = search(v);
  if (res.length === 1) pickProduct(res[0]);
  else if (!res.length) toast('Tidak ada produk yang cocok', 'bad');
}
$('#q').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitQuery(); } });
$('#btnGo').addEventListener('click', submitQuery);
$('#btnManual').addEventListener('click', () => { card = { type: 'unk', code: '' }; scanLock = false; renderCard(); });
// scan baru hanya diabaikan setelah pengguna mulai mengetik di form produk manual
$('#card').addEventListener('input', e => { if (e.target.id && e.target.id.startsWith('unk')) scanLock = true; });
$('#fl').addEventListener('input', renderList);

/* ---------- Kamera ---------- */
let h5 = null, camBusy = false, torchOn = false, lastCode = '', lastAt = 0;
let curLens = null, watchT = null, lastT = -1, stall = 0, restarts = 0;
const track = () => { const v = document.querySelector('#reader video'); return v && v.srcObject && v.srcObject.getVideoTracks()[0]; };

function onDecoded(text) {
  const now = Date.now();
  if (scanLock) return;
  if (text === lastCode && now - lastAt < 1500) { lastAt = now; return; }
  lastCode = text; lastAt = now;
  handleCode(text);
}
async function camStart(deviceId) {
  if (camBusy) return;
  if (!window.Html5Qrcode) return toast('Library scanner belum termuat (perlu internet)', 'bad');
  camBusy = true; $('#btnCam').disabled = true;
  try {
    const F = Html5QrcodeSupportedFormats;
    h5 = new Html5Qrcode('reader', {
      formatsToSupport: [F.EAN_13, F.EAN_8, F.UPC_A, F.UPC_E, F.CODE_128, F.CODE_39, F.ITF],
      useBarCodeDetectorIfSupported: true,
      experimentalFeatures: { useBarCodeDetectorIfSupported: true },
      verbose: false
    });
    curLens = deviceId || null;
    const vc = deviceId
      ? { deviceId: { exact: deviceId }, width: { ideal: 1280 }, height: { ideal: 720 } }
      : { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } };
    await h5.start(
      deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'environment' },
      { fps: 12, videoConstraints: vc, qrbox: (w, h) => ({ width: Math.floor(w * 0.9), height: Math.floor(Math.min(h * 0.5, w * 0.42)) }) },
      onDecoded, () => {}
    );
    $('#cam').classList.add('live');
    $('#btnCam').textContent = 'Matikan kamera';
    $('#btnCam').classList.remove('tag'); $('#btnCam').classList.add('pri');
    setupCaps();
    startWatch();
  } catch (e) {
    console.error(e);
    h5 = null;
    toast('Kamera gagal dinyalakan. Cek izin kamera dan pastikan halaman dibuka lewat HTTPS.', 'bad');
  }
  camBusy = false; $('#btnCam').disabled = false;
}
function stopWatch() { clearInterval(watchT); watchT = null; }
function startWatch() {
  stopWatch(); lastT = -1; stall = 0;
  watchT = setInterval(async () => {
    if (!h5 || camBusy) return;
    const v = document.querySelector('#reader video'), tr = track();
    const dead = !v || !tr || tr.readyState === 'ended';
    if (!dead) {
      if (v.paused) v.play().catch(() => {});
      if (v.currentTime === lastT) stall++; else { stall = 0; lastT = v.currentTime; }
    }
    if (dead || stall >= 2) {
      if (restarts >= 3) { stopWatch(); toast('Kamera macet. Matikan lalu nyalakan lagi.', 'bad'); return; }
      restarts++;
      toast('Kamera macet, menyalakan ulang...');
      const id = curLens;
      await camStop();
      await camStart(id);
    }
  }, 2000);
}
async function camStop() {
  if (!h5) return;
  stopWatch();
  camBusy = true;
  try { await h5.stop(); } catch (e) {}
  try { h5.clear(); } catch (e) {}
  h5 = null; torchOn = false;
  $('#cam').classList.remove('live');
  $('#btnCam').textContent = 'Nyalakan kamera';
  $('#btnCam').classList.add('tag'); $('#btnCam').classList.remove('pri');
  $('#btnTorch').hidden = true; $('#zoomWrap').hidden = true; $('#lens').hidden = true;
  camBusy = false;
}
function setupCaps() {
  const tr = track();
  if (!tr) return;
  const caps = tr.getCapabilities ? tr.getCapabilities() : {};
  const st = tr.getSettings ? tr.getSettings() : {};
  if (caps.focusMode && caps.focusMode.includes('continuous') && st.focusMode && st.focusMode !== 'continuous') tr.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
  $('#btnTorch').hidden = !caps.torch;
  $('#btnTorch').textContent = 'Senter';
  const z = $('#zoom');
  if (caps.zoom) {
    z.min = caps.zoom.min; z.max = Math.min(caps.zoom.max, 6); z.step = caps.zoom.step || 0.1;
    z.value = (tr.getSettings().zoom) || caps.zoom.min;
    $('#zoomWrap').hidden = false;
  } else $('#zoomWrap').hidden = true;
  // enumerateDevices tidak membuka stream baru (getCameras milik library membukanya dan bisa mematikan stream yang sedang jalan)
  if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
    navigator.mediaDevices.enumerateDevices().then(ds => {
      const cs = ds.filter(d => d.kind === 'videoinput');
      const sel = $('#lens');
      if (cs.length < 2) { sel.hidden = true; return; }
      sel.innerHTML = cs.map((c, i) => `<option value="${esc(c.deviceId)}">${esc(c.label || 'Kamera ' + (i + 1))}</option>`).join('');
      if (st.deviceId) sel.value = st.deviceId;
      sel.hidden = false;
    }).catch(() => {});
  }
}
$('#btnCam').addEventListener('click', () => { restarts = 0; return h5 ? camStop() : camStart(); });
$('#lens').addEventListener('change', async e => { const id = e.target.value; restarts = 0; await camStop(); await camStart(id); });
$('#zoom').addEventListener('input', e => { const tr = track(); if (tr) tr.applyConstraints({ advanced: [{ zoom: +e.target.value }] }).catch(() => {}); });
$('#btnTorch').addEventListener('click', async () => {
  const tr = track(); if (!tr) return;
  torchOn = !torchOn;
  try { await tr.applyConstraints({ advanced: [{ torch: torchOn }] }); $('#btnTorch').textContent = torchOn ? 'Senter: nyala' : 'Senter'; }
  catch (e) { torchOn = false; toast('Senter tidak didukung di perangkat ini', 'bad'); }
});
document.addEventListener('visibilitychange', () => { if (document.hidden) camStop(); });

/* ---------- Tab ---------- */
function go(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.id === 'tab-' + name));
  document.querySelectorAll('nav button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  if (name !== 'scan') camStop();
  window.scrollTo(0, 0);
}
$('#nav').addEventListener('click', e => { const b = e.target.closest('button[data-tab]'); if (b) go(b.dataset.tab); });
$('#chip').addEventListener('click', () => go('master'));

/* ---------- Master / reset ---------- */
$('#file').addEventListener('change', e => { const f = e.target.files[0]; if (f) loadFile(f); e.target.value = ''; });
$('#btnGh').addEventListener('click', () => loadGh(false));
$('#ghAuto').addEventListener('change', () => { S.settings.ghAuto = $('#ghAuto').checked; saveSettings(); });
$('#btnXjson').addEventListener('click', () => download(new Blob([JSON.stringify(S.extras.map(p => ({ plu: p.plu, descp: p.desc, s_descp: p.desc, barcode: p.barcode })), null, 1)], { type: 'application/json' }), 'produk_manual_' + stamp() + '.json'));
$('#btnClearScans').addEventListener('click', () => {
  if (!S.scans.length || !confirm('Kosongkan semua hasil scan? Master tidak ikut terhapus.')) return;
  S.scans = []; card = null; DB.set('scans', S.scans); renderCard(); renderList();
});
$('#btnReset').addEventListener('click', async () => {
  if (!confirm('Reset ke setelan awal? Master, hasil scan, produk manual, dan pengaturan akan dihapus dari perangkat ini.')) return;
  await camStop();
  await DB.clear();
  try { localStorage.clear(); } catch (e) {}
  S.master = []; S.meta = null; S.extras = []; S.scans = []; S.settings = { gh: '', ghAuto: false, sess: '' };
  card = null; scanLock = false;
  buildIndex(); renderAll();
  toast('Aplikasi kembali ke setelan awal', 'ok');
});
$('#sess').addEventListener('input', () => { S.settings.sess = $('#sess').value; saveSettings(); });

/* ---------- Ekspor ---------- */
function exportXlsx() {
  if (!S.scans.length) return toast('Belum ada hasil scan', 'bad');
  if (!window.XLSX) return toast('Library Excel belum termuat (perlu internet)', 'bad');
  const rows = [['No', 'Barcode', 'PLU', 'Deskripsi', 'Qty', 'Sumber', 'Waktu scan']];
  S.scans.slice().sort((a, b) => a.ts - b.ts).forEach((x, i) => rows.push([i + 1, x.barcode, x.plu, x.desc, x.qty, x.manual ? 'Manual' : 'Master', new Date(x.ts).toLocaleString('id-ID')]));
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 5 }, { wch: 18 }, { wch: 12 }, { wch: 46 }, { wch: 8 }, { wch: 9 }, { wch: 20 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Opname');
  XLSX.writeFile(wb, 'opname_' + stamp() + '.xlsx');
}
function barcodeImg(code) {
  const c = document.createElement('canvas');
  const tries = /^\d{13}$/.test(code) ? ['EAN13', 'CODE128'] : /^\d{8}$/.test(code) ? ['EAN8', 'CODE128'] : /^\d{12}$/.test(code) ? ['UPC', 'CODE128'] : ['CODE128'];
  for (const f of tries) {
    try {
      JsBarcode(c, code, { format: f, displayValue: true, fontSize: 18, height: 64, width: 2, margin: 8, background: '#ffffff' });
      return { url: c.toDataURL('image/png'), w: c.width, h: c.height };
    } catch (e) {}
  }
  return null;
}
async function exportPdf() {
  if (!S.scans.length) return toast('Belum ada hasil scan', 'bad');
  if (!window.jspdf || !window.JsBarcode) return toast('Library PDF belum termuat (perlu internet)', 'bad');
  toast('Membuat PDF...');
  const doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4' });
  const M = 12, W = 210, RH = 20;
  const items = S.scans.slice().sort((a, b) => a.ts - b.ts);
  const total = items.reduce((n, x) => n + x.qty, 0);
  const sub = `${S.settings.sess || 'Tanpa nama sesi'}  |  ${new Date().toLocaleString('id-ID')}  |  ${items.length} barang, ${total} qty`;
  let y = 0, page = 0;
  const head = () => {
    page++; if (page > 1) doc.addPage();
    doc.setTextColor(20); doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.text('Hasil Stock Opname', M, 16);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.text(sub, M, 21.5); doc.text('Hal. ' + page, W - M, 16, { align: 'right' });
    doc.setFillColor(18, 32, 58); doc.rect(M, 26, W - 2 * M, 7, 'F');
    doc.setTextColor(255); doc.setFont('helvetica', 'bold'); doc.setFontSize(9);
    doc.text('No', M + 2, 30.6); doc.text('Deskripsi', M + 13, 30.6); doc.text('Barcode', M + 102, 30.6); doc.text('Qty', W - M - 2, 30.6, { align: 'right' });
    doc.setTextColor(20); doc.setFont('helvetica', 'normal'); y = 33;
  };
  head();
  for (let i = 0; i < items.length; i++) {
    if (y + RH > 287) head();
    const it = items[i];
    doc.setFontSize(10); doc.setTextColor(20);
    doc.text(String(i + 1), M + 2, y + 7);
    const label = it.desc + (it.manual ? ' (manual)' : '');
    doc.setFontSize(label.length > 60 ? 8.5 : 10);
    doc.text(doc.splitTextToSize(label, 84).slice(0, 3), M + 13, y + 6.5);
    const bc = barcodeImg(it.barcode);
    if (bc) {
      const h = 16, w = Math.min(62, h * bc.w / bc.h);
      doc.addImage(bc.url, 'PNG', M + 102, y + 2, w, h);
    } else { doc.setFontSize(8); doc.text(it.barcode, M + 102, y + 9); }
    doc.setFont('helvetica', 'bold'); doc.setFontSize(12);
    doc.text(String(it.qty), W - M - 2, y + 10, { align: 'right' });
    doc.setFont('helvetica', 'normal');
    doc.setDrawColor(217, 220, 210); doc.line(M, y + RH, W - M, y + RH);
    y += RH;
    if (i % 25 === 24) await new Promise(r => setTimeout(r));
  }
  doc.save('opname_' + stamp() + '.pdf');
  toast('PDF siap diunduh', 'ok');
}
$('#btnXlsx').addEventListener('click', exportXlsx);
$('#btnPdf').addEventListener('click', exportPdf);

/* ---------- Mulai ---------- */
(async function init() {
  await DB.open();
  S.master = (await DB.get('master')) || [];
  S.meta = (await DB.get('meta')) || null;
  S.extras = (await DB.get('extras')) || [];
  S.scans = (await DB.get('scans')) || [];
  S.settings = Object.assign(S.settings, (await DB.get('settings')) || {});
  if (S.master.length && !S.meta) S.meta = { name: 'master', source: 'File', at: Date.now() };
  buildIndex(); renderAll();
  if (S.settings.ghAuto && S.settings.gh) loadGh(true);
})();
