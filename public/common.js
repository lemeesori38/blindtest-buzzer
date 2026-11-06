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
    // Regroupe les ex-aequo sur la même marche
    const top = list.slice().reverse();
    const groups = [];
    for (const p of top) {
      const g = groups[groups.length - 1];
      if (g && g.rank === p.rank) g.players.push(p); else groups.push({ rank: p.rank, score: p.score, players: [p] });
    }
    const steps = [groups[1], groups[0], groups[2]];
    const cls = ['p2', 'p1', 'p3'];
    const medal = ['🥈', '🥇', '🥉'];
    const blocks = steps.map((g, i) => g
      ? `<div class="pod ${cls[i]}"><div class="pm">${medal[i]}</div>${g.players.map(p => `<div class="pn">${this.esc(p.name)}</div>`).join('')}<div class="ps">${pts(g.score)}</div><div class="pb">${g.rank}</div></div>`
      : '<div class="pod empty"></div>').join('');
    const rest = groups.slice(3).flatMap(g => g.players).map(p => `<li><span class="rk">${p.rank}<sup>e</sup></span><span class="nm">${this.esc(p.name)}</span><span class="sc">${pts(p.score)}</span></li>`).join('');
    const winners = groups[0].players.map(p => this.esc(p.name)).join(' & ');
    el.innerHTML = `<div class="rv"><h2 class="rv-title">🏆 Podium</h2><div class="podium">${blocks}</div><div class="champ">Bravo ${winners} !</div>${rest ? `<ol class="others">${rest}</ol>` : ''}</div>`;
    setTimeout(() => this.confetti(), 1300);
  },
  // Pluie de confettis + feux d'artifice (canvas plein écran, ~9 s)
  confetti() {
    if (document.getElementById('fx')) return;
    const cv = document.createElement('canvas');
    cv.id = 'fx';
    cv.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:999';
    document.body.appendChild(cv);
    const ctx = cv.getContext('2d');
    const fit = () => { cv.width = innerWidth * devicePixelRatio; cv.height = innerHeight * devicePixelRatio; ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0); };
    fit(); addEventListener('resize', fit);
    const C = ['#ffc94d', '#ff3d7f', '#4d9dff', '#2fd18b', '#ffffff', '#b06bff'];
    const parts = [];
    const W = () => innerWidth, H = () => innerHeight;
    const rain = n => { for (let i = 0; i < n; i++) parts.push({ x: Math.random() * W(), y: -20 - Math.random() * H() * .5, vx: (Math.random() - .5) * 2, vy: 2 + Math.random() * 3, r: Math.random() * 6.28, vr: (Math.random() - .5) * .3, w: 6 + Math.random() * 6, h: 8 + Math.random() * 8, c: C[i % C.length], t: 'c', life: 1 }); };
    const burst = () => { const x = W() * (.15 + Math.random() * .7), y = H() * (.15 + Math.random() * .35), c = C[Math.floor(Math.random() * C.length)];
      for (let i = 0; i < 70; i++) { const a = Math.random() * 6.28, v = 2 + Math.random() * 5; parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, c, t: 'f', life: 1 }); }
      this.beep(300 + Math.random() * 500, .12); };
    rain(180);
    let n = 0; const bi = setInterval(() => { burst(); if (++n >= 8) clearInterval(bi); }, 700);
    const start = performance.now();
    const loop = now => {
      ctx.clearRect(0, 0, W(), H());
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        if (p.t === 'c') { p.x += p.vx + Math.sin((now + i * 50) / 400); p.y += p.vy; p.r += p.vr;
          ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r))); ctx.restore();
          if (p.y > H() + 20) parts.splice(i, 1);
        } else { p.x += p.vx; p.y += p.vy; p.vy += .06; p.vx *= .985; p.life -= .014;
          ctx.globalAlpha = Math.max(0, p.life); ctx.fillStyle = p.c; ctx.beginPath(); ctx.arc(p.x, p.y, 2.6, 0, 6.28); ctx.fill(); ctx.globalAlpha = 1;
          if (p.life <= 0) parts.splice(i, 1);
        }
      }
      if (now - start < 4000 && Math.random() < .5) rain(2);
      if (parts.length || now - start < 6000) requestAnimationFrame(loop); else { cv.remove(); removeEventListener('resize', fit); }
    };
    requestAnimationFrame(loop);
  },
};
