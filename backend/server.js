const express = require('express');
const cors = require('cors');
const path = require('path');
const { Client } = require('pg');
const app = express();

app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Serve frontend files when running locally
const frontendPath = path.join(__dirname, '..', 'frontend');
app.use(express.static(frontendPath));

// Parse PostgreSQL credentials from CF VCAP_SERVICES
function getDbConfig() {
  const vcap = process.env.VCAP_SERVICES;
  if (!vcap) return null;
  try {
    const services = JSON.parse(vcap);
    const pg = services['postgresql-db'] || services['postgres'] || [];
    if (!pg.length) return null;
    const creds = pg[0].credentials;
    return {
      host:     creds.hostname || creds.host,
      port:     creds.port,
      database: creds.dbname || creds.name,
      user:     creds.username || creds.user,
      password: creds.password,
      ssl:      { rejectUnauthorized: false }
    };
  } catch(e) { return null; }
}

async function getClient() {
  const cfg = getDbConfig();
  if (!cfg) return null;
  const client = new Client(cfg);
  await client.connect();
  return client;
}

async function initDb(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS qm_data (
      id TEXT PRIMARY KEY,
      payload JSONB NOT NULL
    )
  `);
}

app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Temporary in-memory store for RCC import (keyed by week)
let rccImportBuffer = null;

// RCC import endpoint — called from the RCC page via bookmarklet
app.post('/api/rcc-import', (req, res) => {
  rccImportBuffer = { data: req.body, ts: Date.now() };
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ ok: true });
});

// Frontend polls this to pick up the imported data
app.get('/api/rcc-import', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if(!rccImportBuffer || Date.now() - rccImportBuffer.ts > 60000){
    return res.json({ ready: false });
  }
  const payload = rccImportBuffer;
  rccImportBuffer = null; // consume once
  res.json({ ready: true, data: payload.data });
});

app.options('/api/rcc-import', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.sendStatus(204);
});

app.get('/api/data', async (req, res) => {
  const client = await getClient();
  if (!client) return res.json({});
  try {
    await initDb(client);
    const result = await client.query("SELECT payload FROM qm_data WHERE id = 'main'");
    if (result.rows.length) {
      res.json(result.rows[0].payload);
    } else {
      res.json({});
    }
  } catch(e) {
    console.error('GET error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    await client.end();
  }
});

app.post('/api/data', async (req, res) => {
  const client = await getClient();
  if (!client) return res.json({ ok: false, error: 'no db' });
  try {
    await initDb(client);
    await client.query(`
      INSERT INTO qm_data (id, payload) VALUES ('main', $1)
      ON CONFLICT (id) DO UPDATE SET payload = $1
    `, [req.body]);
    res.json({ ok: true });
  } catch(e) {
    console.error('POST error:', e.message);
    res.status(500).json({ error: e.message });
  } finally {
    await client.end();
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log('QM backend running on port ' + port));
