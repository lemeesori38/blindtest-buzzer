// Blind Test Buzzer — serveur sans aucune dépendance (Node 18+)
// Lancer : node server.js   puis ouvrir http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;
// Réglables par le maître du jeu (valeurs par défaut)
const settings = { answerMs: 13000, cooldownMs: 40000, mode: 1, teams: 0, assign: 'master', teamNames: ['Rouge', 'Bleue', 'Verte', 'Jaune'] };
// teams : 0 = chacun pour soi, 2 à 4 = nombre d'équipes ; assign : master | choose | random
const TEAM_COLORS = ['#ff4d5e', '#4d9dff', '#2fd18b', '#ffc94d']; // mode 1 = une réponse, 2 = titre + artiste
const PARTS = () => settings.mode === 2 ? ['title', 'artist'] : ['one'];
const LABELS = { one: 'la réponse', title: 'le titre', artist: "l'artiste" };
const REVEAL_STEP_MS = 3000; // délai entre chaque rang lors du classement

// ---------- État du jeu ----------
let game;
function newGame() {
  game = {
    phase: 'lobby',          // lobby | waiting | open | answering | ended
    players: {},             // id -> {id,name,score,cooldownUntil,lastSeen}
    buzz: null,              // {id,name,at,until} pendant la phase answering
    pending: null,           // dernier buzz pas encore jugé {id,name}
    video: null,             // {id,start,nonce}
    playing: false,
    revealStart: null,
    ranking: null,
    frozen: false,           // buzzers bloqués + pause (pénalités et décompte gelés)
    pausedAt: null,
    history: [],             // buzzeurs de l'extrait en cours, dans l'ordre {id,name,wrong}
    found: {},               // parties trouvées sur cet extrait : { one|title|artist: nom }
    teamScores: [0, 0, 0, 0],
    teamRanking: null,
    mvp: null,
  };
}
newGame();
let answerTimer = null;

// ---------- Connexions temps réel (Server-Sent Events) ----------
const clients = new Set(); // {res, role, pid}

function publicState(client) {
  const now = Date.now();
  const players = Object.values(game.players).map(p => ({
    id: p.id,
    name: p.name,
    connected: [...clients].some(c => c.pid === p.id),
    cooldownUntil: p.cooldownUntil,
    team: p.team,
  }));
  return {
    serverNow: now,
    phase: game.phase,
    players,
    buzz: game.buzz,
    pending: game.pending,
    video: game.video,
    playing: game.playing,
    revealStart: game.revealStart,
    revealStep: REVEAL_STEP_MS,
    frozen: game.frozen,
    pausedAt: game.pausedAt,
    history: game.history,
    found: game.found,
    remaining: PARTS().filter(k => !game.found[k]),
    settings: { answer: settings.answerMs / 1000, cooldown: settings.cooldownMs / 1000, mode: settings.mode, teams: settings.teams, assign: settings.assign },
    teams: teamList(),
    teamRanking: game.phase === 'ended' ? game.teamRanking : null,
    mvp: game.phase === 'ended' ? game.mvp : null,
    // Les points restent cachés jusqu'à la fin de la partie
    ranking: game.phase === 'ended' ? game.ranking : null,
    you: client.pid && game.players[client.pid] ? { id: client.pid, name: game.players[client.pid].name } : null,
  };
}

function broadcast() {
  for (const c of clients) {
    try { c.res.write(`data: ${JSON.stringify(publicState(c))}\n\n`); } catch (e) {}
  }
}

function sendEvent(name, data) {
  for (const c of clients) {
    try { c.res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`); } catch (e) {}
  }
}

setInterval(() => {
  for (const c of clients) { try { c.res.write(': ping\n\n'); } catch (e) {} }
}, 15000);

// ---------- Équipes ----------
function teamList() {
  return Array.from({ length: settings.teams }, (_, i) => ({ id: i, name: settings.teamNames[i], color: TEAM_COLORS[i] }));
}
const inTeams = () => settings.teams > 0;
// Joueurs concernés par une pénalité : le joueur seul, ou toute son équipe
function mates(p) {
  if (!inTeams() || p.team == null) return [p];
  return Object.values(game.players).filter(x => x.team === p.team);
}
function smallestTeam() {
  const n = Array(settings.teams).fill(0);
  for (const p of Object.values(game.players)) if (p.team != null && p.team < settings.teams) n[p.team]++;
  const min = Math.min(...n);
  const c = n.map((v, i) => v === min ? i : -1).filter(i => i >= 0);
  return c[Math.floor(Math.random() * c.length)];
}
function shuffleTeams() {
  const ps = Object.values(game.players);
  for (let i = ps.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [ps[i], ps[j]] = [ps[j], ps[i]]; }
  ps.forEach((p, i) => { p.team = i % settings.teams; });
}

// ---------- Logique ----------
function clearAnswerTimer() { if (answerTimer) { clearTimeout(answerTimer); answerTimer = null; } }

function startAnswerTimer(ms) {
  clearAnswerTimer();
  answerTimer = setTimeout(() => {
    answerTimer = null;
    if (game.phase === 'answering' && !game.frozen) {
      // Fin des 13 s : la vidéo reprend et les autres peuvent buzzer
      game.phase = 'open';
      game.buzz = null;
      game.playing = true;
      broadcast();
    }
  }, Math.max(0, ms));
}

function unfreeze(now) {
  if (!game.frozen) return;
  const delta = now - game.pausedAt;
  // Les pénalités reprennent où elles en étaient
  for (const p of Object.values(game.players))
    if (p.cooldownUntil > game.pausedAt) p.cooldownUntil += delta;
  if (game.phase === 'answering' && game.buzz) {
    game.buzz.until += delta;
    startAnswerTimer(game.buzz.until - now);
  }
  game.frozen = false;
  game.pausedAt = null;
}

// Donne les points pour les parties trouvées (1 point par partie)
function award(id, parts, now) {
  const p = game.players[id];
  if (!p) return { error: 'Joueur inconnu' };
  const left = PARTS().filter(k => !game.found[k]);
  if (!left.length) return { error: 'Tous les points de cet extrait sont déjà donnés' };
  parts = (parts && parts.length ? parts : left).filter(k => left.includes(k));
  if (!parts.length) return { error: 'Déjà trouvé' };
  for (const k of parts) game.found[k] = p.name;
  p.score += parts.length;
  if (inTeams() && p.team != null) game.teamScores[p.team] += parts.length;
  const done = PARTS().every(k => game.found[k]);
  const answering = game.phase === 'answering' && game.buzz;
  if (done) {
    // Tout est trouvé : pas de pénalité, vidéo qui continue, buzzers fermés
    for (const m of mates(p)) m.cooldownUntil = 0;
    clearAnswerTimer();
    game.frozen = false; game.pausedAt = null;
    game.pending = null; game.buzz = null;
    game.phase = 'waiting';
    game.playing = true;
  } else if (!answering || game.buzz.id === id) {
    // Une partie reste à trouver : le joueur garde sa pénalité, les autres peuvent buzzer
    if (game.pending && game.pending.id === id) game.pending = null;
    clearAnswerTimer();
    game.frozen = false; game.pausedAt = null;
    game.buzz = null;
    game.phase = 'open';
    game.playing = true;
  }
  sendEvent('verdict', { ok: true, partial: !done });
  broadcast();
  return { ok: true };
}

function parseYouTube(url) {
  if (!url) return null;
  url = url.trim();
  let id = null, start = 0;
  if (/^[\w-]{11}$/.test(url)) id = url;
  const m = url.match(/(?:v=|youtu\.be\/|shorts\/|embed\/|live\/)([\w-]{11})/);
  if (m) id = m[1];
  const t = url.match(/[?&](?:t|start)=(\d+)/);
  if (t) start = parseInt(t[1], 10);
  return id ? { id, start } : null;
}

function handleAction(a) {
  const now = Date.now();
  switch (a.type) {
    case 'join': {
      const name = String(a.name || '').trim().slice(0, 20);
      if (!name || !a.pid) return { error: 'Pseudo manquant' };
      const p = game.players[a.pid];
      if (p) p.name = name;
      else {
        game.players[a.pid] = { id: a.pid, name, score: 0, cooldownUntil: 0, team: null };
        if (inTeams() && settings.assign === 'random') game.players[a.pid].team = smallestTeam();
      }
      break;
    }
    case 'buzz': {
      const p = game.players[a.pid];
      if (!p) return { error: 'Joueur inconnu' };
      if (game.frozen) return { error: 'Buzzers bloqués' };
      if (game.phase !== 'open') return { error: 'Buzzers fermés' };
      if (now < p.cooldownUntil) return { error: 'Temps mort' };
      if (inTeams() && p.team == null) return { error: 'Tu n\'as pas encore d\'équipe' };
      // Premier arrivé = premier servi : on bascule tout de suite en phase réponse
      game.phase = 'answering';
      game.playing = false;
      game.buzz = { id: p.id, name: p.name, team: inTeams() ? p.team : null, at: now, until: now + settings.answerMs };
      game.pending = { id: p.id, name: p.name };
      for (const m of mates(p)) m.cooldownUntil = now + settings.cooldownMs; // pénalité pour toute l'équipe
      startAnswerTimer(settings.answerMs);
      if (!game.history.some(h => h.id === p.id)) game.history.push({ id: p.id, name: p.name, team: inTeams() ? p.team : null, wrong: false });
      sendEvent('buzz', { name: p.name });
      break;
    }
    case 'valid': {
      if (!game.pending) return { error: 'Aucune réponse à valider' };
      return award(game.pending.id, a.parts, now);
    }
    case 'stop': { // fin du décompte sans juger : pénalité gardée, les autres peuvent buzzer
      if (game.phase !== 'answering') return { error: 'Personne ne répond' };
      clearAnswerTimer();
      game.frozen = false; game.pausedAt = null;
      game.phase = 'open';
      game.buzz = null;
      game.playing = true;
      break;
    }
    case 'teams': { // chacun pour soi (0) ou 2 à 4 équipes + mode de constitution
      const n = Number(a.count);
      const count = [0, 2, 3, 4].includes(n) ? n : settings.teams;
      const assign = ['master', 'choose', 'random'].includes(a.assign) ? a.assign : settings.assign;
      const changed = count !== settings.teams || assign !== settings.assign;
      settings.teams = count; settings.assign = assign;
      for (const p of Object.values(game.players)) if (p.team != null && p.team >= count) p.team = null;
      if (changed && count && assign === 'random') shuffleTeams();
      break;
    }
    case 'shuffle': if (!inTeams()) return { error: 'Pas d\'équipes' }; shuffleTeams(); break;
    case 'setTeam': { // le maître place un joueur, ou un joueur choisit son équipe
      const p = game.players[a.id || a.pid];
      if (!p) return { error: 'Joueur inconnu' };
      if (!a.master && settings.assign !== 'choose') return { error: 'C\'est le maître du jeu qui fait les équipes' };
      const t = a.team === null || a.team === '' ? null : Number(a.team);
      if (t !== null && !(t >= 0 && t < settings.teams)) return { error: 'Équipe inconnue' };
      p.team = t; // les points déjà gagnés restent à l'ancienne équipe
      break;
    }
    case 'teamName': {
      const t = Number(a.team), name = String(a.name || '').trim().slice(0, 16);
      if (!(t >= 0 && t < 4) || !name) return { error: 'Nom invalide' };
      settings.teamNames[t] = name;
      break;
    }
    case 'mode': {
      const m = Number(a.mode) === 2 ? 2 : 1;
      if (m !== settings.mode) { settings.mode = m; game.found = {}; }
      break;
    }
    case 'award': { // valider le point après coup, depuis la liste des buzzeurs
      if (!game.history.some(h => h.id === a.id)) return { error: 'Ce joueur n\'a pas buzzé sur cet extrait' };
      return award(a.id, a.parts, now);
    }
    case 'settings': {
      const ans = Math.round(Number(a.answer)), cd = Math.round(Number(a.cooldown));
      if (!(ans >= 3 && ans <= 120)) return { error: 'Temps de réponse : entre 3 et 120 s' };
      if (!(cd >= 0 && cd <= 300)) return { error: 'Pénalité : entre 0 et 300 s' };
      settings.answerMs = ans * 1000; settings.cooldownMs = cd * 1000;
      break;
    }
    case 'wrong': {
      if (!game.pending) return { error: 'Aucune réponse à refuser' };
      { const h = game.history.find(x => x.id === game.pending.id); if (h) h.wrong = true; }
      unfreeze(now);
      clearAnswerTimer();
      game.pending = null;
      game.buzz = null;
      game.phase = 'open';
      game.playing = true;
      sendEvent('verdict', { ok: false });
      break;
    }
    case 'next': { // nouvel extrait : buzzers ouverts, toutes les pénalités effacées
      clearAnswerTimer();
      game.frozen = false; game.pausedAt = null;
      for (const p of Object.values(game.players)) p.cooldownUntil = 0;
      game.history = []; game.found = {};
      game.buzz = null;
      game.pending = null;
      game.phase = 'open';
      game.playing = true;
      break;
    }
    case 'freeze': { // bloquer-pause / débloquer-lecture (bouton bascule)
      if (game.phase === 'ended') break;
      if (!game.frozen) {
        game.frozen = true;
        game.pausedAt = now;
        game.playing = false;
        clearAnswerTimer();
      } else {
        unfreeze(now);
        game.playing = game.phase !== 'answering' && game.phase !== 'lobby';
      }
      break;
    }
    case 'seek': { // avancer / reculer dans la vidéo (sur l'écran)
      const d = Math.max(-600, Math.min(600, Number(a.delta) || 0));
      sendEvent('seek', { delta: d });
      return { ok: true };
    }
    case 'video': {
      const v = parseYouTube(a.url);
      if (!v) return { error: 'Lien YouTube non reconnu' };
      game.video = { ...v, nonce: now };
      game.playing = false;
      break;
    }
    case 'kick': delete game.players[a.id]; break;
    case 'end': {
      clearAnswerTimer();
      game.buzz = null;
      game.pending = null;
      game.playing = false;
      game.phase = 'ended';
      game.frozen = false; game.pausedAt = null;
      // Classement du dernier au premier (rang avec gestion des ex-aequo)
      const sorted = Object.values(game.players).sort((x, y) => y.score - x.score);
      let rank = 0, prev = null;
      const ranked = sorted.map((p, i) => {
        if (p.score !== prev) { rank++; prev = p.score; } // ex-aequo : même rang, sans sauter de numéro
        return { name: p.name, score: p.score, rank };
      });
      game.ranking = ranked.reverse();
      if (inTeams()) {
        const ts = teamList().map(t => ({ ...t, score: game.teamScores[t.id], members: Object.values(game.players).filter(p => p.team === t.id).map(p => p.name) }))
          .sort((x, y) => y.score - x.score);
        let r = 0, pv = null;
        ts.forEach(t => { if (t.score !== pv) { r++; pv = t.score; } t.rank = r; });
        game.teamRanking = ts.reverse();
        const best = Math.max(0, ...Object.values(game.players).map(p => p.score));
        game.mvp = best > 0 ? { score: best, names: Object.values(game.players).filter(p => p.score === best).map(p => p.name) } : null;
      } else { game.teamRanking = null; game.mvp = null; }
      game.revealStart = now + 1500;
      break;
    }
    case 'reset': { // nouvelle partie avec les mêmes joueurs
      clearAnswerTimer();
      const keep = game.players;
      const video = game.video;
      newGame();
      for (const p of Object.values(keep)) game.players[p.id] = { ...p, score: 0, cooldownUntil: 0 };
      game.video = video;
      break;
    }
    case 'wipe': clearAnswerTimer(); newGame(); break;
    default: return { error: 'Action inconnue' };
  }
  broadcast();
  return { ok: true };
}

// ---------- Serveur HTTP ----------
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };
const ROUTES = { '/': 'index.html', '/ecran': 'ecran.html', '/maitre': 'maitre.html', '/joueur': 'joueur.html' };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  console.log(new Date().toISOString(), req.method, req.url);

  if (url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 1500\n\n');
    const client = { res, role: url.searchParams.get('role'), pid: url.searchParams.get('pid') };
    clients.add(client);
    res.write(`data: ${JSON.stringify(publicState(client))}\n\n`);
    broadcast();
    req.on('close', () => { clients.delete(client); broadcast(); });
    return;
  }

  if (url.pathname === '/action' && req.method === 'POST') {
    let body = '';
    req.on('data', d => { body += d; if (body.length > 10000) req.destroy(); });
    req.on('end', () => {
      let result;
      try { result = handleAction(JSON.parse(body)); } catch (e) { result = { error: 'Requête invalide' }; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }

  const file = ROUTES[url.pathname] || url.pathname.slice(1);
  const full = path.join(PUBLIC, path.normalize(file));
  if (!full.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Introuvable'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🎵 Blind Test Buzzer lancé sur le port ${PORT}`);
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) for (const n of list || [])
    if (n.family === 'IPv4' && !n.internal) console.log(`   Sur le Wi-Fi : http://${n.address}:${PORT}`);
  console.log(`   Sur ce PC   : http://localhost:${PORT}\n`);
});
