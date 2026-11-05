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
  // Classement révélé un par un, puis podium (synchronisé sur tous les écrans).
  // Le DOM n'est modifié qu'au changement d'étape, pour que les animations ne rejouent pas.
  renderReveal(el, s) {
    const list = s.ranking || [];
    const n = list.length;
    const shown = Math.max(0, Math.floor((this.now() - s.revealStart) / s.revealStep) + 1);
    const pts = x => `${x} pt${x > 1 ? 's' : ''}`;
    const stage = !n ? 'empty' : shown === 0 ? 'intro' : shown <= n ? 'list' : 'podium';
    if (stage === 'empty') {
      if (el.dataset.stage !== 'empty') { el.dataset.stage = 'empty'; el.innerHTML = '<p class="muted" style="text-align:center">Aucun joueur</p>'; }
      return;
    }
    if (stage === 'intro') {
      if (el.dataset.stage !== 'intro') { el.dataset.stage = 'intro'; el.innerHTML = '<div class="rv"><h2 class="rv-title">🏁 Fin de la partie</h2><p class="rv-wait">Place au classement…</p></div>'; }
      return;
    }
    if (stage === 'list') {
      if (el.dataset.stage !== 'list') {
        el.dataset.stage = 'list'; el.dataset.count = '0';
        el.innerHTML = '<div class="rv"><h2 class="rv-title">Classement</h2><ol class="reveal"></ol><p class="rv-wait">Suspense…</p></div>';
      }
      const ol = el.querySelector('ol');
      let c = +el.dataset.count;
      while (c < shown) {
        const p = list[c];
        ol.querySelectorAll('.fresh').forEach(x => x.classList.remove('fresh'));
        const li = document.createElement('li');
        li.className = 'rank-in fresh';
        li.innerHTML = `<span class="rk">${p.rank}<sup>${p.rank === 1 ? 'er' : 'e'}</sup></span><span class="nm">${this.esc(p.name)}</span>`;
        ol.prepend(li); // le meilleur finit en haut
        c++;
      }
      el.dataset.count = String(c);
      const w = el.querySelector('.rv-wait'); if (w) w.style.visibility = shown < n ? 'visible' : 'hidden';
      return;
    }
    if (el.dataset.stage === 'podium') return;
    el.dataset.stage = 'podium';
    const top = list.slice().reverse();
    const pod = [top[1], top[0], top[2]];
    const cls = ['p2', 'p1', 'p3'];
    const medal = { 1: '🥇', 2: '🥈', 3: '🥉' };
    const blocks = pod.map((p, i) => p
      ? `<div class="pod ${cls[i]}"><div class="pm">${medal[p.rank] || ''}</div><div class="pn">${this.esc(p.name)}</div><div class="ps">${pts(p.score)}</div><div class="pb">${p.rank}</div></div>`
      : '<div class="pod empty"></div>').join('');
    const rest = top.slice(3).map(p => `<li><span class="rk">${p.rank}<sup>e</sup></span><span class="nm">${this.esc(p.name)}</span><span class="sc">${pts(p.score)}</span></li>`).join('');
    el.innerHTML = `<div class="rv"><h2 class="rv-title">🏆 Podium</h2><div class="podium">${blocks}</div>${rest ? `<ol class="others">${rest}</ol>` : ''}</div>`;
  },
};
