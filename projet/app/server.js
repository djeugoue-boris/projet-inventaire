const express = require('express');
const { Pool } = require('pg');
const client = require('prom-client');

const app = express();
app.use(express.json());

const pool = new Pool({
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

const log = (level, msg, extra = {}) =>
  console.log(JSON.stringify({ time: new Date().toISOString(), level, msg, ...extra }));

// Metriques Prometheus
client.collectDefaultMetrics();
const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duree des requetes HTTP en secondes',
  labelNames: ['method', 'route', 'status'],
  buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
});

app.use((req, res, next) => {
  const end = httpDuration.startTimer();
  res.on('finish', () => {
    const route = req.route ? req.route.path : 'non_trouvee';
    end({ method: req.method, route, status: String(res.statusCode) });
    if (route !== '/metrics') {
      log(res.statusCode >= 500 ? 'error' : 'info', 'requete', {
        method: req.method, path: req.path, status: res.statusCode,
      });
    }
  });
  next();
});

// Routes
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.get('/api/ready', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ready' });
  } catch (e) {
    res.status(503).json({ status: 'base indisponible' });
  }
});

app.get('/api/items', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, nom, cree_le FROM items ORDER BY id DESC');
    res.json(rows);
  } catch (e) {
    log('error', 'lecture impossible', { erreur: e.message });
    res.status(500).json({ erreur: 'lecture impossible' });
  }
});

app.post('/api/items', async (req, res) => {
  const nom = (req.body && req.body.nom || '').trim();
  if (!nom) return res.status(400).json({ erreur: 'le champ nom est obligatoire' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO items (nom) VALUES ($1) RETURNING id, nom, cree_le', [nom]);
    res.status(201).json(rows[0]);
  } catch (e) {
    log('error', 'ecriture impossible', { erreur: e.message });
    res.status(500).json({ erreur: 'ecriture impossible' });
  }
});

app.get('/api/cpu', (req, res) => {
  const ms = Math.min(Number(req.query.ms) || 100, 2000);
  const fin = Date.now() + ms;
  let x = 0;
  while (Date.now() < fin) { x += Math.sqrt(Math.random()); }
  res.json({ travail_ms: ms });
});

app.get('/metrics', async (req, res) => {
  res.set('Content-Type', client.register.contentType);
  res.end(await client.register.metrics());
});

// Demarrage : attendre la base puis creer la table
async function initDb() {
  for (let i = 1; i <= 30; i++) {
    try {
      await pool.query(`CREATE TABLE IF NOT EXISTS items (
        id SERIAL PRIMARY KEY,
        nom TEXT NOT NULL,
        cree_le TIMESTAMPTZ DEFAULT now())`);
      log('info', 'base prete');
      return;
    } catch (e) {
      log('warn', 'base indisponible, nouvel essai', { tentative: i });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  log('error', 'base injoignable, arret');
  process.exit(1);
}

const port = Number(process.env.PORT || 3000);
initDb().then(() => {
  const server = app.listen(port, () => log('info', `API demarree sur le port ${port}`));
  process.on('SIGTERM', () => {
    log('info', 'SIGTERM recu, arret propre');
    server.close(() => pool.end().then(() => process.exit(0)));
  });
});
