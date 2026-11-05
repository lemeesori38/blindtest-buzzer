// Outils partagés : connexion temps réel, horloge synchronisée, actions
const BT = {
  offset: 0,
  state: null,
  now() { return Date.now() + this.offset; },
  // Horloge du jeu : figée pendant la pause (pénalités et décompte gelés)
  gameNow(s) { s = s || this.state; return s && s.frozen && s.pausedAt ? s.pausedAt : this.now(); },
  connect(role, pid, onState, onEvent = {}) {
    const qs = new URLSearchParams({ role, pid: pid || '' });
    const es = new EventSource('/events?' + qs);
    es.onmessage = e => {
      const s = JSON.parse(e.data);
      this.offset = s.serverNow - Date.now();
      this.state = s;
      onState(s);
      setStatus(true);
    };
    for (const [name, fn] of Object.entries(onEvent)) es.addEventListener(name, e => fn(JSON.parse(e.data)));
    es.onerror = () => setStatus(false);
    function setStatus(ok) {
      const el = document.getElementById('net');
      if (el) { el.textContent = ok ? '● connecté' : '● reconnexion…'; el.className = ok ? 'net ok' : 'net ko'; }
    }
    return es;
  },
  async act(data) {
    try {
      const r = await fetch('/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      return await r.json();
    } catch (e) { return { error: 'Réseau indisponible' }; }
  },
  pid() {
    let id = null;
    try { id = localStorage.getItem('bt_pid'); } catch (e) {}
    if (!id) {
      id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
      try { localStorage.setItem('bt_pid', id); } catch (e) {}
    }
    return id;
  },
  async keepAwake() {
    try { if ('wakeLock' in navigator) await navigator.wakeLock.request('screen'); } catch (e) {}
  },
  beep(freq = 880, dur = 0.25) {
    try {
      this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
      const o = this.ctx.createOscillator(), g = this.ctx.createGain();
      o.type = 'square'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.25, this.ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + dur);
      o.connect(g); g.connect(this.ctx.destination);
      o.start(); o.stop(this.ctx.currentTime + dur);
    } catch (e) {}
  },
  esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); },
  // Classement révélé un par un, puis podium (synchronisé sur tous les écrans)
  renderReveal(el, s) {
    const list = s.ranking || [];
    const shown = Math.max(0, Math.floor((this.now() - s.revealStart) / s.revealStep) + 1);
    if (!list.length) { el.innerHTML = '<p class="muted">Aucun joueur</p>'; return; }
    if (shown <= list.length) {
      const items = list.slice(0, shown).map((p, i) =>
        `<li class="rank-in ${i === shown - 1 ? 'fresh' : ''}"><span class="rk">${p.rank}<sup>${p.rank === 1 ? 'er' : 'e'}</sup></span><span class="nm">${this.esc(p.name)}</span></li>`).join('');
      el.innerHTML = `<h2>Classement</h2><ol class="reveal">${items}</ol>${shown < list.length ? '<p class="muted pulse">…</p>' : ''}`;
    } else {
      const top = list.slice().reverse();
      const pod = [top[1], top[0], top[2]];
      const cls = ['p2', 'p1', 'p3'];
      const blocks = pod.map((p, i) => p ? `<div class="pod ${cls[i]}"><div class="pn">${this.esc(p.name)}</div><div class="ps">${p.score} pt${p.score > 1 ? 's' : ''}</div><div class="pb">${p.rank}</div></div>` : '<div class="pod empty"></div>').join('');
      const rest = top.slice(3).map(p => `<li><span class="rk">${p.rank}<sup>e</sup></span><span class="nm">${this.esc(p.name)}</span><span class="sc">${p.score} pt${p.score > 1 ? 's' : ''}</span></li>`).join('');
      el.innerHTML = `<h2>🏆 Podium</h2><div class="podium">${blocks}</div>${rest ? `<ol class="others">${rest}</ol>` : ''}`;
    }
  },
};
