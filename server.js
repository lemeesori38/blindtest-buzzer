// Blind Test Buzzer — serveur sans aucune dépendance (Node 18+)
// Lancer : node server.js   puis ouvrir http://localhost:3000
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;
const ANSWER_MS = 13000;   // temps pour répondre après un buzz
const COOLDOWN_MS = 40000; // temps mort du joueur qui a buzzé
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

// ---------- Logique ----------
function clearAnswerTimer() { if (answerTimer) { clearTimeout(answerTimer); answerTimer = null; } }

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
      else game.players[a.pid] = { id: a.pid, name, score: 0, cooldownUntil: 0 };
      break;
    }
    case 'buzz': {
      const p = game.players[a.pid];
      if (!p) return { error: 'Joueur inconnu' };
      if (game.phase !== 'open') return { error: 'Buzzers fermés' };
      if (now < p.cooldownUntil) return { error: 'Temps mort' };
      // Premier arrivé = premier servi : on bascule tout de suite en phase réponse
      game.phase = 'answering';
      game.playing = false;
      game.buzz = { id: p.id, name: p.name, at: now, until: now + ANSWER_MS };
      game.pending = { id: p.id, name: p.name };
      p.cooldownUntil = now + COOLDOWN_MS;
      clearAnswerTimer();
      answerTimer = setTimeout(() => {
        answerTimer = null;
        if (game.phase === 'answering') {
          // Fin des 13 s : la vidéo reprend et les autres peuvent buzzer
          game.phase = 'open';
          game.buzz = null;
          game.playing = true;
          broadcast();
        }
      }, ANSWER_MS);
      sendEvent('buzz', { name: p.name });
      break;
    }
    case 'valid': {
      if (!game.pending) return { error: 'Aucune réponse à valider' };
      const p = game.players[game.pending.id];
      if (p) p.score += 1;
      clearAnswerTimer();
      game.pending = null;
      game.buzz = null;
      game.phase = 'waiting';   // le maître relance au prochain extrait
      game.playing = false;
      sendEvent('verdict', { ok: true });
      break;
    }
    case 'wrong': {
      if (!game.pending) return { error: 'Aucune réponse à refuser' };
      clearAnswerTimer();
      game.pending = null;
      game.buzz = null;
      game.phase = 'open';
      game.playing = true;
      sendEvent('verdict', { ok: false });
      break;
    }
    case 'next': { // nouvel extrait : on ouvre les buzzers
      clearAnswerTimer();
      game.buzz = null;
      game.pending = null;
      game.phase = 'open';
      game.playing = true;
      break;
    }
    case 'lock': {
      clearAnswerTimer();
      game.buzz = null;
      game.phase = 'waiting';
      game.playing = false;
      break;
    }
    case 'play': game.playing = true; break;
    case 'pause': game.playing = false; break;
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
      // Classement du dernier au premier (rang avec gestion des ex-aequo)
      const sorted = Object.values(game.players).sort((x, y) => y.score - x.score);
      let rank = 0, prev = null;
      const ranked = sorted.map((p, i) => {
        if (p.score !== prev) { rank = i + 1; prev = p.score; }
        return { name: p.name, score: p.score, rank };
      });
      game.ranking = ranked.reverse();
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
