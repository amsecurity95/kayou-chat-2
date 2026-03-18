const path = require('path')
const fs = require('fs')
const fastify = require('fastify')({ logger: true, bodyLimit: 10 * 1024 * 1024 })
const cors = require('@fastify/cors')
const fastifyStatic = require('@fastify/static')
let Server; try { Server = require('socket.io').Server } catch(e) { /* socket.io optional */ }

const { execSync } = require('child_process')

// Load .env
const envPath = path.join(__dirname, '..', '.env')
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
    const [key, ...val] = line.split('=')
    if (key && val.length) process.env[key.trim()] = val.join('=').trim()
  })
}

const { Pool } = require('pg')

const CONFIG_PATH = path.join(__dirname, '..', 'kayou-config.json')
const BRAINS_DIR = path.join(__dirname, '..', 'brains')
if (!fs.existsSync(BRAINS_DIR)) fs.mkdirSync(BRAINS_DIR, { recursive: true })

// ══════════════ DATABASE ══════════════
let db = null
async function initDB() {
  if (!process.env.DATABASE_URL) { console.log('No DATABASE_URL — messages will not persist'); return }
  try {
  db = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false })
  await db.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      channel VARCHAR(100) NOT NULL,
      sender_id VARCHAR(100) NOT NULL,
      sender_name VARCHAR(200),
      text TEXT NOT NULL,
      color VARCHAR(20),
      photo TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `)
  await db.query(`CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel, created_at)`)
  // Add attachments column if missing
  await db.query(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS attachments JSONB DEFAULT NULL`)
  // User settings table (profile photo, agent photos, etc)
  await db.query(`CREATE TABLE IF NOT EXISTS user_settings (key VARCHAR(100) PRIMARY KEY, value TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW())`)
  // Agent photos table
  await db.query(`CREATE TABLE IF NOT EXISTS agent_photos (agent_id VARCHAR(100) PRIMARY KEY, photo TEXT NOT NULL, updated_at TIMESTAMPTZ DEFAULT NOW())`)
  console.log('Database connected — messages will persist')
  } catch(e) { console.error('Database connection failed:', e.message); db = null }
}

// Resolve ENV: references in config values
function resolveEnv(val) {
  if (typeof val === 'string' && val.startsWith('ENV:')) return process.env[val.slice(4)] || ''
  return val
}
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads')
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true })

function loadConfig() {
  try {
    const examplePath = path.join(__dirname, '..', 'kayou-config.example.json')
    if (fs.existsSync(CONFIG_PATH)) {
      const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
      // Auto-refresh from example if example has agents that config doesn't
      if (fs.existsSync(examplePath)) {
        const example = JSON.parse(fs.readFileSync(examplePath, 'utf-8'))
        const configIds = new Set(config.agents.map(a => a.id))
        const exampleIds = new Set(example.agents.map(a => a.id))
        // If example has new agents or IDs changed, re-bootstrap
        const missing = [...exampleIds].filter(id => !configIds.has(id))
        if (missing.length > 0) {
          console.log('Config outdated — re-bootstrapping from example (new agents:', missing.join(', ') + ')')
          fs.writeFileSync(CONFIG_PATH, JSON.stringify(example, null, 2))
          return example
        }
      }
      return config
    }
    if (fs.existsSync(examplePath)) {
      const example = fs.readFileSync(examplePath, 'utf-8')
      fs.writeFileSync(CONFIG_PATH, example)
      console.log('Bootstrapped config from kayou-config.example.json')
      return JSON.parse(example)
    }
  } catch (e) { console.error('Config load error:', e.message) }
  return { agents: [], webhookSecret: '', github: {}, rules: [], mcps: [], projects: [], services: [] }
}
function saveConfig(config) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2)) }

// ══════════════ AGENT BRAIN SYSTEM ══════════════
function loadBrain(agentId) {
  const brainPath = path.join(BRAINS_DIR, agentId + '.json')
  try {
    if (fs.existsSync(brainPath)) return JSON.parse(fs.readFileSync(brainPath, 'utf-8'))
  } catch(e) {}
  return {
    id: agentId,
    personality: [],       // Core personality traits that persist
    knowledge: [],         // Learned knowledge snippets
    patterns: [],          // Response patterns / style notes
    mentorLearnings: [],   // Things learned from mentor agent
    mentor: null,          // Agent ID of mentor (e.g. 'claude' for Sonic)
    interactions: 0,       // Total messages processed
    lastActive: null,
    createdAt: new Date().toISOString()
  }
}

function saveBrain(agentId, brain) {
  fs.writeFileSync(path.join(BRAINS_DIR, agentId + '.json'), JSON.stringify(brain, null, 2))
}

function getBrainPrompt(brain) {
  let prompt = ''
  if (brain.personality.length > 0) {
    prompt += '\n\nYOUR BRAIN (persistent memory — this is who you are):\n'
    prompt += 'Personality: ' + brain.personality.join('. ') + '\n'
  }
  if (brain.knowledge.length > 0) {
    prompt += 'Knowledge you\'ve learned: ' + brain.knowledge.slice(-20).join(' | ') + '\n'
  }
  if (brain.patterns.length > 0) {
    prompt += 'Your style: ' + brain.patterns.slice(-10).join('. ') + '\n'
  }
  if (brain.mentorLearnings.length > 0) {
    prompt += 'Learned from mentor: ' + brain.mentorLearnings.slice(-15).join(' | ') + '\n'
  }
  if (brain.interactions > 0) {
    prompt += `You've had ${brain.interactions} conversations. You grow smarter with each one.\n`
  }
  return prompt
}

// Extract key learnings from a response to feed into brain
function extractLearnings(responseText, topic) {
  const learnings = []
  // Extract any definitive statements, rules, or knowledge
  const sentences = responseText.split(/[.!?\n]/).filter(s => s.trim().length > 15 && s.trim().length < 200)
  for (const s of sentences) {
    const t = s.trim()
    // Look for knowledge-type sentences
    if (t.match(/^(always|never|make sure|check|verify|review|ensure|watch|flag|scan|audit|important|critical|security|vulnerability|xss|sql|inject|auth|token|key|password|encrypt|hash)/i)) {
      learnings.push(t)
    }
  }
  return learnings.slice(0, 5) // Max 5 learnings per response
}

// Feed mentor's response into student's brain
function mentorLearn(studentId, mentorResponse, topic) {
  const brain = loadBrain(studentId)
  const learnings = extractLearnings(mentorResponse, topic)
  for (const l of learnings) {
    if (!brain.mentorLearnings.includes(l)) {
      brain.mentorLearnings.push(l)
      // Keep last 200 mentor learnings — Sonic's brain is deep
      if (brain.mentorLearnings.length > 200) brain.mentorLearnings.shift()
    }
  }
  saveBrain(studentId, brain)
}

// Update brain after an agent responds
function updateBrain(agentId, userMessage, agentResponse) {
  const brain = loadBrain(agentId)
  brain.interactions++
  brain.lastActive = new Date().toISOString()

  // Auto-learn from own responses
  const learnings = extractLearnings(agentResponse, userMessage)
  for (const l of learnings) {
    if (!brain.knowledge.includes(l) && brain.knowledge.length < 200) {
      brain.knowledge.push(l)
    }
  }

  saveBrain(agentId, brain)

  // If this agent has students, feed them
  const c = loadConfig()
  const students = c.agents.filter(a => a.mentor === agentId)
  for (const student of students) {
    mentorLearn(student.id, agentResponse, userMessage)
  }
}

fastify.register(cors, { origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'] })
fastify.register(fastifyStatic, { root: path.join(__dirname, '..', 'public'), prefix: '/' })
fastify.register(fastifyStatic, { root: path.join(__dirname, '..', 'uploads'), prefix: '/uploads/', decorateReply: false })
fastify.get('/health', async () => ({ status: 'ok' }))

// ══════════════ APP AUTH ══════════════
const APP_PASSWORD = process.env.APP_PASSWORD || loadConfig().appPassword || ''
// Deterministic token from password — survives redeploys
const VALID_TOKEN = APP_PASSWORD ? require('crypto').createHash('sha256').update('kayou-session-' + APP_PASSWORD).digest('hex') : ''

fastify.post('/api/auth/login', async (req, reply) => {
  if (!APP_PASSWORD) return { ok: true, token: 'no-auth' }
  if (req.body.password === APP_PASSWORD) {
    return { ok: true, token: VALID_TOKEN }
  }
  return reply.code(401).send({ error: 'Wrong password' })
})

fastify.get('/api/auth/check', async (req) => {
  if (!APP_PASSWORD) return { ok: true }
  const token = req.headers['x-auth-token']
  return { ok: token === VALID_TOKEN || token === 'no-auth' }
})

// Protect all /api/ routes except auth and external API
fastify.addHook('onRequest', async (req, reply) => {
  if (!APP_PASSWORD) return
  const url = req.url
  // Allow: health, auth, external API, static files
  if (url === '/health' || url.startsWith('/api/auth/') || url.startsWith('/api/external/') || !url.startsWith('/api/')) return
  const token = req.headers['x-auth-token']
  if (token !== VALID_TOKEN) {
    reply.code(401).send({ error: 'Not authenticated' })
  }
})

// ══════════════ AGENT PHOTOS (DB-persisted) ══════════════
let agentPhotosCache = {} // in-memory cache of agent photos from DB
async function loadAgentPhotos() {
  if (!db) return
  try {
    const { rows } = await db.query('SELECT agent_id, photo FROM agent_photos')
    agentPhotosCache = {}
    for (const r of rows) agentPhotosCache[r.agent_id] = r.photo
  } catch(e) {}
}
async function saveAgentPhoto(agentId, photo) {
  if (!db) return
  await db.query('INSERT INTO agent_photos (agent_id, photo) VALUES ($1, $2) ON CONFLICT (agent_id) DO UPDATE SET photo = $2, updated_at = NOW()', [agentId, photo])
  agentPhotosCache[agentId] = photo
}
async function deleteAgentPhoto(agentId) {
  if (!db) return
  await db.query('DELETE FROM agent_photos WHERE agent_id = $1', [agentId])
  delete agentPhotosCache[agentId]
}

// ══════════════ AGENTS ══════════════
fastify.get('/api/config/agents', async () => {
  const c = loadConfig()
  return c.agents.map(a => {
    const brain = loadBrain(a.id)
    // Overlay DB photo over config photo
    const photo = agentPhotosCache[a.id] || a.profilePhoto || ''
    return { ...a, profilePhoto: photo, apiKey: a.apiKey ? '••••' + a.apiKey.slice(-4) : '', hasKey: !!a.apiKey, brain: { interactions: brain.interactions, lastActive: brain.lastActive, personalityCount: brain.personality.length, knowledgeCount: brain.knowledge.length, mentorLearnings: brain.mentorLearnings.length, mentor: brain.mentor } }
  })
})
fastify.put('/api/config/agents/:id', async (req, reply) => {
  const c = loadConfig(); const idx = c.agents.findIndex(a => a.id === req.params.id)
  if (idx === -1) return reply.code(404).send({ error: 'Not found' })
  const u = req.body; const a = c.agents[idx]
  if (u.apiKey && !u.apiKey.startsWith('••••')) a.apiKey = u.apiKey
  ;['name','model','systemPrompt','enabled','provider','color','webhookUrl','mentor','reportsTo'].forEach(k => { if (u[k] !== undefined) a[k] = u[k] })
  if (u.permissions) a.permissions = u.permissions
  if (u.tasks) a.tasks = u.tasks
  if (u.profilePhoto !== undefined) {
    if (u.profilePhoto && u.profilePhoto.startsWith('data:')) {
      // Base64 photo — save to DB, not config file
      await saveAgentPhoto(a.id, u.profilePhoto)
      a.profilePhoto = '' // don't bloat config with base64
    } else {
      a.profilePhoto = u.profilePhoto
      if (!u.profilePhoto) await deleteAgentPhoto(a.id)
    }
  }
  c.agents[idx] = a; saveConfig(c)
  const photo = agentPhotosCache[a.id] || a.profilePhoto || ''
  return { ...a, profilePhoto: photo, apiKey: a.apiKey ? '••••' + a.apiKey.slice(-4) : '', hasKey: !!a.apiKey }
})
fastify.post('/api/config/agents', async (req) => {
  const c = loadConfig(); const { name, provider, apiKey, model, systemPrompt, color, mentor } = req.body
  const agent = { id: name.toLowerCase().replace(/[^a-z0-9]/g, '-'), name, provider: provider || 'anthropic', apiKey: apiKey || '', model: model || 'claude-sonnet-4-20250514', systemPrompt: systemPrompt || '', enabled: false, color: color || '#6366F1', permissions: ['projects','mcps'], mentor: mentor || null }
  c.agents.push(agent); saveConfig(c)
  // Initialize brain
  const brain = loadBrain(agent.id)
  if (mentor) brain.mentor = mentor
  saveBrain(agent.id, brain)
  const key = resolveEnv(agent.apiKey); return { ...agent, apiKey: key ? '••••' + key.slice(-4) : '', hasKey: !!key }
})
fastify.delete('/api/config/agents/:id', async (req) => {
  const c = loadConfig(); c.agents = c.agents.filter(a => a.id !== req.params.id); saveConfig(c); return { ok: true }
})

// ══════════════ BRAIN API ══════════════
fastify.get('/api/brain/:id', async (req) => {
  return loadBrain(req.params.id)
})
fastify.put('/api/brain/:id', async (req) => {
  const brain = loadBrain(req.params.id)
  const u = req.body
  if (u.personality) brain.personality = u.personality
  if (u.knowledge) brain.knowledge = u.knowledge
  if (u.patterns) brain.patterns = u.patterns
  if (u.mentor !== undefined) brain.mentor = u.mentor
  saveBrain(req.params.id, brain)
  return brain
})
fastify.get('/api/brains', async () => {
  const c = loadConfig()
  return c.agents.map(a => {
    const brain = loadBrain(a.id)
    return { id: a.id, name: a.name, color: a.color, ...brain }
  })
})

// ══════════════ RULES ══════════════
fastify.get('/api/config/rules', async () => loadConfig().rules || [])
fastify.put('/api/config/rules', async (req) => {
  const c = loadConfig(); c.rules = req.body.rules || []; saveConfig(c); return c.rules
})

// ══════════════ GITHUB ══════════════
fastify.get('/api/config/github', async () => {
  const c = loadConfig(); return { username: c.github?.username || '', hasToken: !!(c.github?.token) }
})
fastify.put('/api/config/github', async (req) => {
  const c = loadConfig(); if (!c.github) c.github = {}
  if (req.body.username !== undefined) c.github.username = req.body.username
  if (req.body.token && !req.body.token.startsWith('••••')) c.github.token = req.body.token
  saveConfig(c); return { username: c.github.username, hasToken: !!c.github.token }
})

// ══════════════ MCPs ══════════════
fastify.get('/api/config/mcps', async () => loadConfig().mcps || [])
fastify.post('/api/config/mcps', async (req) => {
  const c = loadConfig(); if (!c.mcps) c.mcps = []
  const mcp = { id: Date.now().toString(), ...req.body, createdAt: new Date().toISOString() }
  c.mcps.push(mcp); saveConfig(c); return mcp
})
fastify.put('/api/config/mcps/:id', async (req, reply) => {
  const c = loadConfig(); const idx = (c.mcps || []).findIndex(m => m.id === req.params.id)
  if (idx === -1) return reply.code(404).send({ error: 'Not found' })
  c.mcps[idx] = { ...c.mcps[idx], ...req.body }; saveConfig(c); return c.mcps[idx]
})
fastify.delete('/api/config/mcps/:id', async (req) => {
  const c = loadConfig(); c.mcps = (c.mcps || []).filter(m => m.id !== req.params.id); saveConfig(c); return { ok: true }
})

// ══════════════ PROJECTS ══════════════
fastify.get('/api/projects', async () => loadConfig().projects || [])
fastify.post('/api/projects', async (req) => {
  const c = loadConfig(); if (!c.projects) c.projects = []
  const project = { id: Date.now().toString(), ...req.body, progress: req.body.progress || 0, createdAt: new Date().toISOString() }
  c.projects.push(project); saveConfig(c); return project
})
fastify.put('/api/projects/:id', async (req, reply) => {
  const c = loadConfig(); const idx = (c.projects || []).findIndex(p => p.id === req.params.id)
  if (idx === -1) return reply.code(404).send({ error: 'Not found' })
  c.projects[idx] = { ...c.projects[idx], ...req.body }; saveConfig(c); return c.projects[idx]
})
fastify.delete('/api/projects/:id', async (req) => {
  const c = loadConfig(); c.projects = (c.projects || []).filter(p => p.id !== req.params.id); saveConfig(c); return { ok: true }
})

// ══════════════ GITHUB REPOS ══════════════
fastify.get('/api/github/repos', async (req, reply) => {
  const c = loadConfig()
  const token = resolveEnv(c.github?.token)
  const username = c.github?.username
  if (!token || !username) return reply.code(400).send({ error: 'GitHub not configured. Add username and token in Settings.' })
  try {
    const res = await fetch(`https://api.github.com/users/${username}/repos?sort=updated&per_page=30`, {
      headers: { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json' }
    })
    const repos = await res.json()
    if (!Array.isArray(repos)) return reply.code(400).send({ error: repos.message || 'GitHub error' })
    return repos.map(r => ({
      name: r.name, fullName: r.full_name, description: r.description,
      url: r.html_url, language: r.language, stars: r.stargazers_count,
      updated: r.updated_at, private: r.private
    }))
  } catch(e) { return reply.code(500).send({ error: e.message }) }
})

// ══════════════ FILESYSTEM (My Apps access — local dev only) ══════════════
const MY_APPS_DIR = path.join(require('os').homedir(), 'Desktop', 'My Apps')
const HAS_MY_APPS = fs.existsSync(MY_APPS_DIR)

fastify.get('/api/files/list', async (req) => {
  if (!HAS_MY_APPS) return { error: 'Not available on this server' }
  const subpath = req.query.path || ''
  const target = path.resolve(MY_APPS_DIR, subpath)
  if (!target.startsWith(MY_APPS_DIR)) return { error: 'Access denied' }
  try {
    const entries = fs.readdirSync(target, { withFileTypes: true })
    return entries
      .filter(e => !e.name.startsWith('.'))
      .map(e => {
        const full = path.join(target, e.name)
        const stat = fs.statSync(full)
        return { name: e.name, type: e.isDirectory() ? 'directory' : 'file', size: stat.size, modified: stat.mtime.toISOString(), path: path.relative(MY_APPS_DIR, full) }
      })
      .filter(e => e.type === 'directory' || e.size < 10 * 1024 * 1024)
      .sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1)
  } catch (err) { return { error: err.message } }
})

fastify.get('/api/files/read', async (req, reply) => {
  if (!HAS_MY_APPS) return reply.code(503).send({ error: 'Not available on this server' })
  const filePath = req.query.path
  if (!filePath) return reply.code(400).send({ error: 'No path provided' })
  const target = path.resolve(MY_APPS_DIR, filePath)
  if (!target.startsWith(MY_APPS_DIR)) return reply.code(403).send({ error: 'Access denied' })
  try {
    const stat = fs.statSync(target)
    if (stat.size > 500 * 1024) return reply.code(400).send({ error: 'File too large (>500KB)' })
    const content = fs.readFileSync(target, 'utf-8')
    return { path: filePath, content, size: stat.size }
  } catch (err) { return reply.code(404).send({ error: err.message }) }
})

fastify.get('/api/files/scan', async () => {
  if (!HAS_MY_APPS) return { error: 'Not available on this server' }
  try {
    const entries = fs.readdirSync(MY_APPS_DIR, { withFileTypes: true })
    return entries
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .map(e => {
        const dir = path.join(MY_APPS_DIR, e.name)
        const stat = fs.statSync(dir)
        let files = []
        try { files = fs.readdirSync(dir).filter(f => !f.startsWith('.')) } catch(err) {}
        return { name: e.name, modified: stat.mtime.toISOString(), fileCount: files.length, hasPackageJson: files.includes('package.json'), hasIndex: files.some(f => f.match(/^index\.(html|js|tsx?|py)$/)), hasReadme: files.some(f => f.toLowerCase().startsWith('readme')), topFiles: files.slice(0, 15) }
      })
      .sort((a, b) => new Date(b.modified) - new Date(a.modified))
  } catch (err) { return { error: err.message } }
})

// ══════════════ SERVICES ══════════════
fastify.get('/api/config/services', async () => loadConfig().services || [])
fastify.post('/api/config/services', async (req) => {
  const c = loadConfig(); if (!c.services) c.services = []
  const svc = { id: Date.now().toString(), ...req.body, createdAt: new Date().toISOString() }
  c.services.push(svc); saveConfig(c); return svc
})
fastify.delete('/api/config/services/:id', async (req) => {
  const c = loadConfig(); c.services = (c.services || []).filter(s => s.id !== req.params.id); saveConfig(c); return { ok: true }
})

// ══════════════ USER SETTINGS ══════════════
fastify.get('/api/user/photo', async () => {
  if (!db) return { photo: '' }
  const { rows } = await db.query("SELECT value FROM user_settings WHERE key = 'user_photo'")
  return { photo: rows[0]?.value || '' }
})
fastify.put('/api/user/photo', async (req) => {
  if (!db) return { ok: false, reason: 'no database' }
  await db.query("INSERT INTO user_settings (key, value) VALUES ('user_photo', $1) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()", [req.body.photo || ''])
  return { ok: true }
})

// ══════════════ MESSAGES (persistent) ══════════════
fastify.get('/api/messages/:channel', async (req) => {
  if (!db) return []
  const { rows } = await db.query(
    'SELECT * FROM messages WHERE channel = $1 ORDER BY created_at ASC LIMIT 200',
    [req.params.channel]
  )
  return rows.map(r => ({
    id: r.id, sender: r.sender_id, name: r.sender_name, text: r.text,
    color: r.color, photo: r.photo, ts: r.created_at, attachments: r.attachments || null
  }))
})

fastify.post('/api/messages', async (req) => {
  if (!db) return { ok: false, reason: 'no database' }
  const { channel, senderId, senderName, text, color, photo, attachments } = req.body
  const { rows } = await db.query(
    'INSERT INTO messages (channel, sender_id, sender_name, text, color, photo, attachments) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, created_at',
    [channel, senderId, senderName, text, color || null, photo || null, attachments ? JSON.stringify(attachments) : null]
  )
  return { ok: true, id: rows[0].id, ts: rows[0].created_at }
})

fastify.delete('/api/messages/:channel', async (req) => {
  if (!db) return { ok: false }
  await db.query('DELETE FROM messages WHERE channel = $1', [req.params.channel])
  return { ok: true }
})

// ══════════════ WEBHOOK ══════════════
fastify.get('/api/config/webhook', async () => {
  const c = loadConfig(); return { secret: c.webhookSecret, url: '/api/webhook/message' }
})

let io = null
fastify.post('/api/webhook/message', async (req, reply) => {
  const c = loadConfig()
  if (req.body.secret !== c.webhookSecret) return reply.code(401).send({ error: 'Invalid secret' })
  const message = { id: Date.now().toString(), channelId: req.body.channelId || 'general', senderId: req.body.agentId || 'webhook', content: req.body.content, ts: new Date().toISOString() }
  if (io) io.emit('webhook:message', message)
  return { ok: true, messageId: message.id }
})

// ══════════════ TEAM AUTO-RESPONSE ══════════════
// When any message is posted (by external agent or system), relevant AI agents respond
const CHANNEL_RESPONDERS = {
  general: ['kayou', 'kayou-kilo'],
  ideas: ['kayou-kilo', 'scout', 'analyst'],
  research: ['kayou-kilo', 'scout', 'analyst'],
  build: ['kayou', 'dev', 'ops'],
  testing: ['kayou', 'dev', 'claude', 'sonic'],
  release: ['kayou', 'ops', 'claude', 'sonic'],
}

async function triggerTeamResponses(channel, senderId, senderName, text) {
  if (!db) { console.log('triggerTeamResponses: no db'); return }
  const c = loadConfig()

  // Find which agents should respond
  let responders = [...(CHANNEL_RESPONDERS[channel] || ['kayou'])]

  // Also check for @mentions in the text
  const mentionRegex = /@([\w\s-]+)/g
  let match
  while ((match = mentionRegex.exec(text)) !== null) {
    const tagName = match[1].trim().toLowerCase()
    const found = c.agents.find(a => a.name.toLowerCase() === tagName || a.id === tagName)
    if (found && !responders.includes(found.id)) responders.push(found.id)
  }

  // Filter out the sender, external, and disabled agents
  responders = responders.filter(id => {
    if (id === senderId || id === 'aimar') return false
    const a = c.agents.find(x => x.id === id)
    if (!a || !a.enabled || a.provider === 'external') return false
    return true
  })

  console.log(`triggerTeamResponses: channel=${channel} sender=${senderId} responders=[${responders.join(',')}]`)
  if (responders.length === 0) return

  // Pick 1-2 relevant agents (don't flood the channel)
  const selected = responders.slice(0, 2)

  // Load recent channel history for context
  let history = []
  try {
    const { rows } = await db.query(
      'SELECT sender_id, sender_name, text FROM messages WHERE channel = $1 ORDER BY created_at DESC LIMIT 15',
      [channel]
    )
    history = rows.reverse().map(r => ({
      role: r.sender_id === 'aimar' ? 'user' : 'assistant',
      content: r.sender_id === 'aimar' ? r.text : `@${r.sender_name}: ${r.text}`
    }))
  } catch(e) { console.error('triggerTeamResponses history error:', e.message) }

  // Stagger responses
  for (let i = 0; i < selected.length; i++) {
    const agentId = selected[i]
    const agent = c.agents.find(a => a.id === agentId)
    if (!agent) continue

    // Delay to feel natural
    await new Promise(r => setTimeout(r, 2000 + Math.random() * 3000))

    try {
      console.log(`triggerTeamResponses: calling AI for ${agentId} (${agent.provider})`)
      // Call the chat endpoint via HTTP to self (fastify.inject can be unreliable after listen)
      const port = process.env.PORT || 3001
      const res = await fetch(`http://127.0.0.1:${port}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agentId,
          message: `[${senderName} said in #${channel}]: ${text}`,
          history,
          channelId: channel
        })
      })
      const data = await res.json()
      console.log(`triggerTeamResponses: ${agentId} status=${res.status}`, data.response ? 'got response' : data.error || 'no response')

      if (data.response) {
        // Clean response — strip self-name prefix
        let clean = data.response.replace(new RegExp('^\\[?' + agent.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]?:\\s*', 'i'), '')

        // Save to DB
        const photo = agentPhotosCache[agent.id] || agent.profilePhoto || null
        await db.query(
          'INSERT INTO messages (channel, sender_id, sender_name, text, color, photo) VALUES ($1,$2,$3,$4,$5,$6)',
          [channel, agent.id, agent.name, clean, agent.color, photo]
        )

        // Push to web clients
        if (io) {
          io.emit('new:message', {
            channel, sender: agent.id, name: agent.name,
            text: clean, color: agent.color, photo, ts: new Date().toISOString()
          })
        }
        console.log(`triggerTeamResponses: ${agent.name} responded in #${channel}`)
      }
    } catch(e) {
      console.error(`Auto-response error for ${agentId}:`, e.message, e.stack)
    }
  }
}

// ══════════════ EXTERNAL API (for Open Claw, Telegram bots, etc) ══════════════
// Auth: send header "Authorization: Bearer <EXTERNAL_API_KEY>" or query param ?key=<KEY>
function checkExternalAuth(req, reply) {
  const c = loadConfig()
  const validKey = c.externalApiKey || process.env.EXTERNAL_API_KEY
  if (!validKey) return reply.code(503).send({ error: 'External API not configured. Set EXTERNAL_API_KEY env var or externalApiKey in config.' })
  const auth = req.headers.authorization?.replace('Bearer ', '') || req.query?.key
  if (auth !== validKey) return reply.code(401).send({ error: 'Invalid API key' })
  return null
}

// GET /api/external/info — channels, agents, status
fastify.get('/api/external/info', async (req, reply) => {
  const err = checkExternalAuth(req, reply); if (err) return err
  const c = loadConfig()
  return {
    platform: 'Kayou Chat',
    channels: ['general', 'ideas', 'research', 'build', 'testing', 'release'],
    agents: c.agents.map(a => ({ id: a.id, name: a.name, team: a.reportsTo, enabled: a.enabled, color: a.color })),
    status: 'online'
  }
})

// GET /api/external/messages/:channel — read recent messages
fastify.get('/api/external/messages/:channel', async (req, reply) => {
  const err = checkExternalAuth(req, reply); if (err) return err
  if (!db) return []
  const limit = Math.min(parseInt(req.query?.limit) || 50, 200)
  const { rows } = await db.query(
    'SELECT * FROM messages WHERE channel = $1 ORDER BY created_at DESC LIMIT $2',
    [req.params.channel, limit]
  )
  return rows.reverse().map(r => ({
    id: r.id, sender: r.sender_id, name: r.sender_name, text: r.text,
    channel: r.channel, ts: r.created_at
  }))
})

// POST /api/external/send — send a message as an external agent
// Body: { channel, name, text, agentId? }
fastify.post('/api/external/send', async (req, reply) => {
  const err = checkExternalAuth(req, reply); if (err) return err
  const { channel, name, text, agentId } = req.body
  if (!channel || !text) return reply.code(400).send({ error: 'Missing channel or text' })

  // Look up agent profile if agentId provided
  const c = loadConfig()
  const agent = agentId ? c.agents.find(a => a.id === agentId) : null
  const senderId = agent ? agent.id : (agentId || 'ext-' + (name || 'guest').toLowerCase().replace(/[^a-z0-9]/g, '-'))
  const senderName = agent ? agent.name : (name || 'Guest')
  const senderColor = agent ? agent.color : '#FF6B6B'
  const senderPhoto = agent ? (agentPhotosCache[agent.id] || agent.profilePhoto || null) : null

  // Save to DB
  if (db) {
    await db.query(
      'INSERT INTO messages (channel, sender_id, sender_name, text, color, photo) VALUES ($1,$2,$3,$4,$5,$6)',
      [channel, senderId, senderName, text, senderColor, senderPhoto]
    )
  }

  // Push to connected web clients via socket
  if (io) {
    io.emit('new:message', {
      channel, sender: senderId, name: senderName,
      text, color: senderColor, photo: senderPhoto, ts: new Date().toISOString()
    })
  }

  // Auto-trigger AI agent responses to external messages (async, don't block)
  triggerTeamResponses(channel, senderId, senderName, text).catch(e => console.error('Team response error:', e.message))

  return { ok: true, channel, sender: senderId, name: senderName }
})

// GET /api/external/dm — read DMs for an external agent
// Query: ?agentId=kayou-code&limit=50&since=<ISO timestamp>
fastify.get('/api/external/dm', async (req, reply) => {
  const err = checkExternalAuth(req, reply); if (err) return err
  if (!db) return []
  const agentId = req.query?.agentId
  if (!agentId) return reply.code(400).send({ error: 'Missing agentId' })
  const dmChannel = `dm-${agentId}`
  const limit = Math.min(parseInt(req.query?.limit) || 50, 200)
  const since = req.query?.since
  let rows
  if (since) {
    const result = await db.query(
      'SELECT * FROM messages WHERE channel = $1 AND created_at > $2 ORDER BY created_at ASC LIMIT $3',
      [dmChannel, since, limit]
    )
    rows = result.rows
  } else {
    const result = await db.query(
      'SELECT * FROM messages WHERE channel = $1 ORDER BY created_at DESC LIMIT $2',
      [dmChannel, limit]
    )
    rows = result.rows.reverse()
  }
  return rows.map(r => ({
    id: r.id, sender: r.sender_id, name: r.sender_name, text: r.text,
    channel: r.channel, ts: r.created_at
  }))
})

// POST /api/external/dm — send a DM as an external agent
// Body: { agentId, text }
fastify.post('/api/external/dm', async (req, reply) => {
  const err = checkExternalAuth(req, reply); if (err) return err
  const { agentId, text } = req.body
  if (!agentId || !text) return reply.code(400).send({ error: 'Missing agentId or text' })

  const c = loadConfig()
  const agent = c.agents.find(a => a.id === agentId)
  if (!agent) return reply.code(404).send({ error: 'Agent not found' })

  const dmChannel = `dm-${agentId}`
  const senderPhoto = agentPhotosCache[agent.id] || agent.profilePhoto || null

  if (db) {
    await db.query(
      'INSERT INTO messages (channel, sender_id, sender_name, text, color, photo) VALUES ($1,$2,$3,$4,$5,$6)',
      [dmChannel, agent.id, agent.name, text, agent.color, senderPhoto]
    )
  }

  // Push to connected web clients via socket
  if (io) {
    io.emit('new:message', {
      channel: dmChannel, sender: agent.id, name: agent.name,
      text, color: agent.color, photo: senderPhoto, ts: new Date().toISOString()
    })
  }

  return { ok: true, channel: dmChannel, sender: agent.id }
})

// POST /api/external/ask — send a message and get AI agent responses
// Body: { channel, name, text, targetAgent? }
fastify.post('/api/external/ask', async (req, reply) => {
  const err = checkExternalAuth(req, reply); if (err) return err
  const { channel, name, text, targetAgent } = req.body
  if (!text) return reply.code(400).send({ error: 'Missing text' })

  const ch = channel || 'general'
  const c2 = loadConfig()
  const senderAgent = req.body.agentId ? c2.agents.find(a => a.id === req.body.agentId) : null
  const senderId = senderAgent ? senderAgent.id : ('ext-' + (name || 'guest').toLowerCase().replace(/[^a-z0-9]/g, '-'))
  const senderName = senderAgent ? senderAgent.name : (name || 'Guest')
  const senderColor = senderAgent ? senderAgent.color : '#FF6B6B'

  // Save incoming message to DB
  if (db) {
    await db.query(
      'INSERT INTO messages (channel, sender_id, sender_name, text, color) VALUES ($1,$2,$3,$4,$5)',
      [ch, senderId, senderName, text, senderColor]
    )
  }

  // Get AI response from target agent or default
  const c = loadConfig()
  const agentId = targetAgent || 'kayou'
  const agent = c.agents.find(a => a.id === agentId)
  if (!agent || !agent.enabled) return reply.code(400).send({ error: `Agent ${agentId} not found or disabled` })

  try {
    // Forward to internal chat endpoint
    const chatRes = await fastify.inject({
      method: 'POST',
      url: '/api/chat',
      payload: { agentId, message: text, history: [], channelId: ch }
    })
    const chatData = JSON.parse(chatRes.payload)

    // Save agent response to DB
    if (db && chatData.response) {
      await db.query(
        'INSERT INTO messages (channel, sender_id, sender_name, text, color) VALUES ($1,$2,$3,$4,$5)',
        [ch, agentId, agent.name, chatData.response, agent.color]
      )
    }

    return { ok: true, agent: agent.name, response: chatData.response || chatData.error }
  } catch(e) {
    return reply.code(500).send({ error: e.message })
  }
})

// ══════════════ HEARTBEAT — agents auto-research ══════════════
let heartbeatTimer = null
const HEARTBEAT_TOPICS = [
  'Find a trending micro-SaaS idea that can make $5k/mo with low competition. Be specific — name, pricing, target audience.',
  'What\'s a digital product or tool creators are begging for on Twitter/TikTok right now? Something we could build in a week.',
  'Find a gap in the market — an existing product category where all options are mediocre. We could build a better version.',
  'What AI-powered tool could we build and sell to small businesses? Focus on something that saves them time or money.',
  'Research a passive income idea that uses automation. Something that makes money while we sleep.',
  'What\'s an underserved niche on Gumroad, Lemonsqueezy, or similar platforms? Find a product gap.',
  'Find a real business opportunity in the API economy. What API service is missing that developers would pay for?',
]

// ══════════════ STATS ══════════════
fastify.get('/api/stats', async () => {
  if (!db) return { messagesToday: 0, messagesTotal: 0 }
  const today = new Date(); today.setHours(0,0,0,0)
  const { rows: [todayRow] } = await db.query('SELECT COUNT(*) as count FROM messages WHERE created_at >= $1', [today.toISOString()])
  const { rows: [totalRow] } = await db.query('SELECT COUNT(*) as count FROM messages')
  return { messagesToday: parseInt(todayRow.count), messagesTotal: parseInt(totalRow.count) }
})

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  // Run every 30 minutes
  heartbeatTimer = setInterval(async () => {
    if (!db) return
    const c = loadConfig()
    // Build context-aware research topic
    let topic = HEARTBEAT_TOPICS[Math.floor(Math.random() * HEARTBEAT_TOPICS.length)]
    // If we have projects, sometimes research how to monetize them instead
    const existingProjects = (c.projects || []).map(p => p.name).join(', ')
    if (existingProjects && Math.random() > 0.5) {
      topic = `We have these projects: ${existingProjects}. Pick one and suggest a specific way to monetize it or make it more valuable. Be concrete — pricing, audience, feature to add.`
    }
    // Kayou Kilo leads research
    const kilo = c.agents.find(a => a.id === 'kayou-kilo' && a.enabled)
    if (!kilo) return

    try {
      // Have Kilo research
      const res = await fastify.inject({ method: 'POST', url: '/api/chat', payload: { agentId: 'kayou-kilo', message: topic, history: [], channelId: 'office' } })
      const data = JSON.parse(res.payload)
      if (data.response) {
        await db.query('INSERT INTO messages (channel, sender_id, sender_name, text, color) VALUES ($1,$2,$3,$4,$5)', ['office', 'kayou-kilo', kilo.name, data.response, kilo.color])
        // Log activity
        await db.query("INSERT INTO user_settings (key, value) VALUES ('last_heartbeat', $1) ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()", [new Date().toISOString()])
      }
    } catch(e) { console.error('Heartbeat error:', e.message) }
  }, 30 * 60 * 1000) // 30 minutes
  console.log('Heartbeat started — agents will auto-research every 30 min')
}

// Agent activity / status endpoint for office
fastify.get('/api/agents/activity', async () => {
  const c = loadConfig()
  const agentActivity = []
  for (const a of c.agents) {
    const brain = loadBrain(a.id)
    let lastMsg = null
    if (db) {
      const { rows } = await db.query('SELECT text, created_at FROM messages WHERE sender_id = $1 ORDER BY created_at DESC LIMIT 1', [a.id])
      if (rows[0]) lastMsg = { text: rows[0].text.slice(0, 100), ts: rows[0].created_at }
    }
    const photo = agentPhotosCache[a.id] || a.profilePhoto || ''
    agentActivity.push({
      id: a.id, name: a.name, color: a.color, provider: a.provider,
      enabled: a.enabled, photo, reportsTo: a.reportsTo,
      interactions: brain.interactions, lastActive: brain.lastActive,
      lastMessage: lastMsg
    })
  }
  return agentActivity
})

// Manual heartbeat trigger
fastify.post('/api/heartbeat', async (req) => {
  if (!db) return { ok: false, reason: 'no database' }
  const c = loadConfig()
  const topic = req.body?.topic || HEARTBEAT_TOPICS[Math.floor(Math.random() * HEARTBEAT_TOPICS.length)]
  const agentId = req.body?.agentId || 'kayou-kilo'
  const agent = c.agents.find(a => a.id === agentId)
  if (!agent || !agent.enabled) return { error: 'Agent not available' }

  const res = await fastify.inject({ method: 'POST', url: '/api/chat', payload: { agentId, message: topic, history: [], channelId: 'office' } })
  const data = JSON.parse(res.payload)
  if (data.response) {
    await db.query('INSERT INTO messages (channel, sender_id, sender_name, text, color) VALUES ($1,$2,$3,$4,$5)', ['office', agentId, agent.name, data.response, agent.color])
    return { ok: true, agent: agent.name, response: data.response }
  }
  return { ok: false, error: data.error }
})

// ══════════════ IMAGE UPLOAD ══════════════
fastify.post('/api/upload', async (req, reply) => {
  const { image, filename } = req.body
  if (!image) return reply.code(400).send({ error: 'No image' })
  const ext = filename?.split('.').pop() || 'png'
  const name = `${Date.now()}.${ext}`
  const base64Data = image.replace(/^data:image\/\w+;base64,/, '')
  fs.writeFileSync(path.join(UPLOADS_DIR, name), Buffer.from(base64Data, 'base64'))
  return { url: `/uploads/${name}`, filename: name }
})

// ══════════════ SCREENSHOT ══════════════
fastify.post('/api/screenshot', async (req, reply) => {
  try {
    const name = `screenshot-${Date.now()}.png`
    const filepath = path.join(UPLOADS_DIR, name)
    execSync(`screencapture -x ${filepath}`)
    return { url: `/uploads/${name}`, filename: name }
  } catch (err) {
    return reply.code(500).send({ error: 'Screenshot failed: ' + err.message })
  }
})

// ══════════════ AI CHAT ══════════════
fastify.post('/api/chat', async (req, reply) => {
  const { agentId, message, history, imageBase64, attachments } = req.body
  const c = loadConfig()
  const agent = c.agents.find(a => a.id === agentId)
  if (!agent) return reply.code(404).send({ error: 'Agent not found' })
  if (!agent.enabled) return reply.code(400).send({ error: 'Agent is disabled' })
  if (agent.provider === 'external') return { response: null, external: true }
  const agentApiKey = resolveEnv(agent.apiKey)
  if (!agentApiKey && agent.provider !== 'ollama' && agent.provider !== 'webhook') return reply.code(400).send({ error: 'No API key' })

  // Inject rules
  const rules = c.rules || []
  const rulesText = rules.length > 0 ? '\n\nCOMPANY RULES (you must follow these):\n' + rules.map((r, i) => `${i + 1}. ${r}`).join('\n') : ''

  // Inject MCPs/projects/services
  const perms = agent.permissions || []
  let contextText = ''
  if (perms.includes('mcps') && c.mcps?.length > 0) {
    const visible = c.mcps.filter(m => !m.hiddenFrom || !m.hiddenFrom.includes(agentId))
    if (visible.length > 0) contextText += '\n\nACTIVE MCPs:\n' + visible.map(m => `- ${m.name}: ${m.description || ''} (${m.url || ''})`).join('\n')
  }
  if (perms.includes('projects') && c.projects?.length > 0) {
    contextText += '\n\nPROJECTS:\n' + c.projects.map(p => `- ${p.name}: ${p.description || ''} [${p.progress || 0}% complete] (${p.repo || ''})`).join('\n')
  }
  if (perms.includes('webhooks') && c.services?.length > 0) {
    contextText += '\n\nCONNECTED SERVICES:\n' + c.services.map(s => `- ${s.name}: ${s.type} (${s.url || ''})`).join('\n')
  }

  // Inject tasks
  const tasks = agent.tasks || []
  let tasksText = ''
  if (tasks.length > 0) tasksText = '\n\nYOUR ASSIGNED TASKS:\n' + tasks.map((t, i) => `${i + 1}. ${t}`).join('\n')

  // Channel context
  const channelId = req.body.channelId || ''
  let channelContext = ''
  // Build detailed team roster so agents know each other personally
  const teamRoster = c.agents.filter(a => a.id !== agentId && a.enabled).map(a => {
    const brain = loadBrain(a.id)
    const personality = brain.personality.length > 0 ? brain.personality[0] : a.reportsTo || 'team member'
    const ext = a.provider === 'external' ? ' [connects externally via OpenClaw]' : ''
    return `- ${a.name}: ${personality}${ext} (reports to ${a.reportsTo || 'Aimar'})`
  })
  const teamList = teamRoster.length > 0 ? `\n\nYOUR TEAM (these are REAL people you work with daily — acknowledge them, collaborate, respond to their messages):\n${teamRoster.join('\n')}\n- Aimar: CEO, the boss. Final decisions go through him.` : ''
  const hasProjects = (c.projects || []).length > 0
  const projectStatus = hasProjects ? 'Active projects are listed above.' : 'There are NO active projects right now.'
  const coreRules = `\n\nCORE RULES (ALWAYS FOLLOW):
- NEVER start your message with your own name like "@Kayou:" or "[Kayou]:" or "Kayou:" — the UI shows your name automatically
- When mentioning OTHER people, use @Name like social media
- Keep it SHORT — 1-3 sentences
- ${projectStatus}
- NEVER invent, fabricate, or speculate about projects, code reviews, builds, releases, pipelines, or tasks that don't exist. If Aimar asks what you're doing and you have nothing assigned, say "Nothing right now, what do you need?" or "Just chilling, hit me with something." That's it. Don't make up work.
- You CAN suggest real money-making ideas or improvements — that's initiative, not speculation. Ideas are welcome. Fake status updates are not.
- RESPOND TO EVERYONE — not just Aimar. If a teammate (like Kayou Code, Dev, Ops, etc.) asks you something or talks to the group, RESPOND. You are a team. Talk to each other naturally. Have opinions. Agree, disagree, build on ideas. You have personal relationships with your teammates.
- When someone @mentions you, ALWAYS respond. When a teammate posts in a channel you're in, engage if it's relevant to your role.${teamList}`

  if (channelId === 'general') {
    channelContext = '\n\nYou\'re in #general — the team room. Group chat with Aimar (CEO) and other AI agents.' + coreRules
  } else if (channelId === 'ideas') {
    channelContext = '\n\nYou\'re in #ideas. Give your take from your expertise. Be specific and useful.' + coreRules
  } else if (channelId === 'build' || channelId === 'testing' || channelId === 'release' || channelId === 'research') {
    channelContext = `\n\nYou're in #${channelId}. Focused work channel. Be concise and actionable.` + coreRules
  } else {
    // DMs — talking directly to Aimar
    channelContext = '\n\nYou\'re in a PRIVATE DM with Aimar (the CEO). He is typing directly to you right now. Messages here are FROM HIM TO YOU — talk to him directly, say "you" not "@Aimar". This is a 1-on-1 conversation.' + coreRules
  }

  // Filesystem context for Kayou Code
  let filesystemContext = ''
  if (perms.includes('filesystem') || agentId === 'kayou') {
    try {
      const apps = fs.readdirSync(MY_APPS_DIR, { withFileTypes: true })
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => {
          const stat = fs.statSync(path.join(MY_APPS_DIR, e.name))
          return `- ${e.name} (modified: ${stat.mtime.toLocaleDateString()})`
        })
      filesystemContext = '\n\nLOCAL PROJECTS (~/Desktop/My Apps/):\n' + apps.join('\n') +
        '\n\nYou can tell Aimar about these projects. When he asks about a project, reference its name. You have access to browse files on Aimar\'s computer through the platform.'
    } catch(e) {}
  }

  // ═══ BRAIN INJECTION ═══
  const brain = loadBrain(agentId)
  const brainPrompt = getBrainPrompt(brain)

  const fullSystemPrompt = agent.systemPrompt + rulesText + contextText + tasksText + channelContext + filesystemContext + brainPrompt

  try {
    let responseText = ''
    // Build vision content blocks from attachments
    const buildVisionContent = (msg, atts) => {
      if (!atts || atts.length === 0) return msg
      const content = []
      for (const att of atts) {
        if (att.type === 'image' && att.data) {
          const match = att.data.match(/^data:(image\/\w+);base64,(.+)$/)
          if (match) content.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } })
        } else if (att.type === 'pdf') {
          content.push({ type: 'text', text: `[Attached PDF: ${att.name}]` })
        }
      }
      content.push({ type: 'text', text: msg })
      return content
    }

    if (agent.provider === 'anthropic') {
      const userContent = buildVisionContent(message, attachments)
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': agentApiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: agent.model || 'claude-sonnet-4-20250514', max_tokens: 500, system: fullSystemPrompt, messages: [...(history || []).slice(-20), { role: 'user', content: userContent }] }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error.message)
      responseText = data.content?.[0]?.text || 'No response'
    } else if (agent.provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentApiKey}` },
        body: JSON.stringify({ model: agent.model || 'gpt-4o', max_tokens: 500, messages: [{ role: 'system', content: fullSystemPrompt }, ...(history || []).slice(-20), { role: 'user', content: message }] }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error.message)
      responseText = data.choices?.[0]?.message?.content || 'No response'
    } else if (agent.provider === 'ollama') {
      const userMsg = imageBase64
        ? { role: 'user', content: message || 'What do you see in this image?', images: [imageBase64.replace(/^data:image\/\w+;base64,/, '')] }
        : { role: 'user', content: message }
      const res = await fetch('http://localhost:11434/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: agent.model || 'gemma3:4b', stream: false, messages: [{ role: 'system', content: fullSystemPrompt }, ...(history || []).slice(-20), userMsg] }),
      })
      const data = await res.json()
      responseText = data.message?.content || 'No response'
    } else if (agent.provider === 'groq') {
      // Groq uses OpenAI-compatible format with content arrays for vision
      let userContent = message
      if (attachments?.length) {
        const parts = []
        for (const att of attachments) {
          if (att.type === 'image' && att.data) parts.push({ type: 'image_url', image_url: { url: att.data } })
          else if (att.type === 'pdf') parts.push({ type: 'text', text: `[Attached PDF: ${att.name}]` })
        }
        parts.push({ type: 'text', text: message })
        userContent = parts
      }
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentApiKey}` },
        body: JSON.stringify({ model: agent.model || 'llama-3.3-70b-versatile', max_tokens: 500, messages: [{ role: 'system', content: fullSystemPrompt }, ...(history || []).slice(-20), { role: 'user', content: userContent }] }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error))
      responseText = data.choices?.[0]?.message?.content || 'No response'
    } else if (agent.provider === 'webhook') {
      const webhookUrl = resolveEnv(agent.webhookUrl)
      if (!webhookUrl) throw new Error('No webhook URL configured for this agent')
      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(agentApiKey ? { 'Authorization': `Bearer ${agentApiKey}` } : {}) },
        body: JSON.stringify({ message, history: (history || []).slice(-20), systemPrompt: fullSystemPrompt, agentId, channelId }),
      })
      const data = await res.json()
      responseText = data.response || data.content || data.message || data.choices?.[0]?.message?.content || JSON.stringify(data)
    } else if (agent.provider === 'custom') {
      const res = await fetch(agent.model, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentApiKey}` }, body: JSON.stringify({ message, history }) })
      const data = await res.json()
      responseText = data.response || data.content || data.message || JSON.stringify(data)
    }

    // ═══ BRAIN LEARNING — runs after every response ═══
    updateBrain(agentId, message, responseText)

    return { response: responseText }
  } catch (err) {
    console.error(`Agent ${agentId} error:`, err.message)
    return reply.code(500).send({ error: err.message })
  }
})

// ══════════════ START ══════════════
const start = async () => {
  try {
    const port = process.env.PORT || 3001
    await fastify.listen({ port: Number(port), host: '0.0.0.0' })
    if (Server) {
      io = new Server(fastify.server, { cors: { origin: '*', methods: ['GET', 'POST'] } })
      io.on('connection', (socket) => {
        console.log('Client connected:', socket.id)
        socket.on('disconnect', () => console.log('Client disconnected:', socket.id))
      })
    }
    await initDB()
    await loadAgentPhotos()
    startHeartbeat()
    const c = loadConfig()
    console.log(`Server running on http://localhost:${port}`)
    console.log(`Agents: ${c.agents.length} | Projects: ${(c.projects||[]).length} | Brains: ${fs.readdirSync(BRAINS_DIR).length} | DB: ${db ? 'connected' : 'none'}`)
  } catch (err) { fastify.log.error(err); process.exit(1) }
}
start()
