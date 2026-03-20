const path = require('path')
const fs = require('fs')
const fastify = require('fastify')({ logger: true, bodyLimit: 10 * 1024 * 1024 })
const cors = require('@fastify/cors')
const fastifyStatic = require('@fastify/static')
let Server; try { Server = require('socket.io').Server } catch(e) { /* socket.io optional */ }
// Upload-Post uses REST API directly — no SDK needed

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
  // Social media management tables
  await db.query(`CREATE TABLE IF NOT EXISTS social_accounts (
    id SERIAL PRIMARY KEY,
    client_name VARCHAR(200) NOT NULL,
    upload_post_user VARCHAR(200),
    platforms JSONB DEFAULT '[]',
    connected_at TIMESTAMPTZ DEFAULT NOW(),
    notes TEXT
  )`)
  await db.query(`CREATE TABLE IF NOT EXISTS social_posts (
    id SERIAL PRIMARY KEY,
    account_id INTEGER REFERENCES social_accounts(id),
    status VARCHAR(20) DEFAULT 'draft',
    content_type VARCHAR(20) DEFAULT 'text',
    title TEXT NOT NULL,
    description TEXT,
    media_urls JSONB DEFAULT '[]',
    platforms JSONB DEFAULT '[]',
    platform_options JSONB DEFAULT '{}',
    scheduled_date TIMESTAMPTZ,
    drafted_by VARCHAR(100),
    approved_by VARCHAR(100),
    rejected_reason TEXT,
    upload_post_job_id VARCHAR(200),
    upload_post_status JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  )`)
  // Social dashboard users table
  await db.query(`CREATE TABLE IF NOT EXISTS social_users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(200) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    credits INTEGER DEFAULT 3,
    persona JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`)
  // Add persona column if missing (for existing tables)
  await db.query(`ALTER TABLE social_users ADD COLUMN IF NOT EXISTS persona JSONB DEFAULT '{}'`)
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
  // Allow: health, auth, external API, social auth/dashboard, static files
  if (url === '/health' || url.startsWith('/api/auth/') || url.startsWith('/api/external/') || url.startsWith('/api/social/auth/') || url.startsWith('/api/social/dashboard/') || !url.startsWith('/api/')) return
  const token = req.headers['x-auth-token']
  if (token !== VALID_TOKEN) {
    reply.code(401).send({ error: 'Not authenticated' })
  }
})

// ══════════════ TOOL EXECUTION LOG ══════════════
const toolLog = [] // in-memory log, max 100 entries
function logToolExec(agentId, toolName, args, result, success) {
  toolLog.unshift({ agentId, tool: toolName, args, result: (result.output || result.error || '').slice(0, 500), success, ts: new Date().toISOString() })
  if (toolLog.length > 100) toolLog.length = 100
}

// ══════════════ AGENT PHOTOS (DB-persisted) ══════════════
let agentPhotosCache = {} // in-memory cache of agent photos from DB
let groqRateLimit = { remainingTokens: null, limitTokens: null, remainingRequests: null, limitRequests: null, resetTokens: null, lastUpdated: null }

function captureGroqRateLimit(res) {
  const h = (name) => res.headers.get(name)
  const rt = h('x-ratelimit-remaining-tokens')
  const lt = h('x-ratelimit-limit-tokens')
  const rr = h('x-ratelimit-remaining-requests')
  const lr = h('x-ratelimit-limit-requests')
  const resetT = h('x-ratelimit-reset-tokens')
  if (rt !== null) groqRateLimit.remainingTokens = parseInt(rt)
  if (lt !== null) groqRateLimit.limitTokens = parseInt(lt)
  if (rr !== null) groqRateLimit.remainingRequests = parseInt(rr)
  if (lr !== null) groqRateLimit.limitRequests = parseInt(lr)
  if (resetT) groqRateLimit.resetTokens = resetT
  groqRateLimit.lastUpdated = new Date().toISOString()
}
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
  // Get the LATEST 200 messages (subquery DESC, then reverse to ASC for display)
  const { rows } = await db.query(
    'SELECT * FROM (SELECT * FROM messages WHERE channel = $1 ORDER BY created_at DESC LIMIT 200) sub ORDER BY created_at ASC',
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

// ══════════════ TOOL CALLING ══════════════
// Available tools that agents can call
const AGENT_TOOLS = {
  github: { description: 'GitHub API — create issues, list issues, list repos. Args format: "create_issue owner/repo Title | Body" or "list_issues owner/repo" or "list_repos"', isAsync: true },
  git: { description: 'Git — status, log, diff, branch', allowedArgs: /^(status|log|diff|branch|remote|show|ls-files)\b/ },
  ls: { description: 'List files in a directory', allowedArgs: /^[^\;|&`$]+$/ },
  cat: { description: 'Read file contents', allowedArgs: /^[^\;|&`$]+$/ },
  curl: { description: 'HTTP requests (GET only)', allowedArgs: /^-s\s/ },
  node: { description: 'Run a Node.js one-liner', allowedArgs: /^-e\s/ },
}

// Admin tools — only for authorized agents (Claude)
const ADMIN_TOOLS = {
  manage_agent: {
    description: 'Enable or disable an agent. Use when an agent is misbehaving or causing problems. Args format: "disable <agent_id>" or "enable <agent_id>". Agent IDs: kayou, dev, ops, kayou-kilo, scout, analyst, sonic.',
  }
}

function executeAdminTool(toolName, args, callerAgentId) {
  if (toolName === 'manage_agent') {
    const match = args.match(/^(enable|disable)\s+([\w-]+)$/)
    if (!match) return { error: 'Format: "enable <agent_id>" or "disable <agent_id>"' }
    const [, action, targetId] = match
    if (targetId === 'claude' || targetId === 'aimar') return { error: 'Cannot modify Claude or Aimar' }
    if (targetId === callerAgentId) return { error: 'Cannot modify yourself' }

    const c = loadConfig()
    const target = c.agents.find(a => a.id === targetId)
    if (!target) return { error: `Agent "${targetId}" not found` }

    target.enabled = action === 'enable'
    saveConfig(c)
    console.log(`ADMIN: ${callerAgentId} ${action}d agent ${targetId}`)
    return { output: `${target.name} has been ${action}d.` }
  }
  return { error: 'Unknown admin tool' }
}

// Blocked patterns for safety
const BLOCKED_PATTERNS = /rm\s+-rf|rm\s+\/|sudo|chmod|chown|mkfs|dd\s+if|>\s*\/dev|passwd|shutdown|reboot|kill\s+-9|pkill|eval\s*\(|exec\s*\(/i

async function executeGithubTool(args) {
  const c = loadConfig()
  const token = resolveEnv(c.github?.token)
  if (!token) return { error: 'GitHub token not configured' }
  const headers = { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json', 'Content-Type': 'application/json', 'User-Agent': 'KayouChat' }
  const ghFetch = async (url, opts = {}) => {
    const res = await fetch(`https://api.github.com${url}`, { headers, ...opts })
    return res.json()
  }

  if (args.startsWith('create_issue ')) {
    const rest = args.slice(13)
    const [repoPath, ...titleBody] = rest.split(' ')
    const fullText = titleBody.join(' ')
    const [title, ...bodyParts] = fullText.split('|')
    const body = bodyParts.join('|').trim() || ''
    const data = await ghFetch(`/repos/${repoPath}/issues`, { method: 'POST', body: JSON.stringify({ title: title.trim(), body }) })
    if (data.html_url) return { output: `Issue created: ${data.html_url}` }
    return { error: data.message || 'Failed to create issue' }
  }
  if (args.startsWith('list_issues ')) {
    const repo = args.slice(12).trim()
    const data = await ghFetch(`/repos/${repo}/issues?state=open&per_page=10`)
    if (Array.isArray(data)) return { output: data.map(i => `#${i.number}: ${i.title} (${i.state})`).join('\n') || 'No open issues' }
    return { error: data.message || 'Failed' }
  }
  if (args.startsWith('list_repos')) {
    const data = await ghFetch('/user/repos?sort=updated&per_page=10')
    if (Array.isArray(data)) return { output: data.map(r => `${r.full_name} — ${r.description || 'no desc'}`).join('\n') }
    return { error: data.message || 'Failed' }
  }
  if (args.startsWith('close_issue ')) {
    const rest = args.slice(12).trim()
    const [repo, num] = rest.split(' ')
    const data = await ghFetch(`/repos/${repo}/issues/${num}`, { method: 'PATCH', body: JSON.stringify({ state: 'closed' }) })
    if (data.html_url) return { output: `Issue #${num} closed: ${data.html_url}` }
    return { error: data.message || 'Failed' }
  }
  return { error: 'Unknown github command. Use: create_issue, list_issues, list_repos, close_issue' }
}

async function executeToolCall(toolName, args, callerAgentId) {
  // Check admin tools first
  if (ADMIN_TOOLS[toolName]) return executeAdminTool(toolName, args, callerAgentId)
  if (!AGENT_TOOLS[toolName]) return { error: `Unknown tool: ${toolName}` }
  if (BLOCKED_PATTERNS.test(args)) return { error: 'Blocked: dangerous command' }

  // Async tools (GitHub)
  if (toolName === 'github') {
    const result = await executeGithubTool(args)
    logToolExec(callerAgentId, toolName, args, result, !!result.output)
    return result
  }

  const tool = AGENT_TOOLS[toolName]
  if (tool.allowedArgs && !tool.allowedArgs.test(args)) {
    return { error: `Not allowed: ${toolName} ${args.slice(0, 50)}` }
  }

  const cmd = `${toolName} ${args}`
  try {
    const output = execSync(cmd, {
      timeout: 15000,
      maxBuffer: 50 * 1024,
      encoding: 'utf-8',
      cwd: path.join(__dirname, '..'),
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    })
    const result = { output: output.slice(0, 3000) }
    logToolExec(callerAgentId, toolName, args, result, true)
    return result
  } catch(e) {
    const result = { error: e.message?.slice(0, 500) || 'Command failed' }
    logToolExec(callerAgentId, toolName, args, result, false)
    return result
  }
}

// Build tool definitions for Groq/OpenAI format
function getGroqTools(agentPerms, agentId) {
  if (!agentPerms?.includes('tools')) return undefined
  const allTools = { ...AGENT_TOOLS }
  if (agentPerms?.includes('admin')) Object.assign(allTools, ADMIN_TOOLS)
  return Object.entries(allTools).map(([name, def]) => ({
    type: 'function',
    function: {
      name,
      description: def.description,
      parameters: {
        type: 'object',
        properties: { args: { type: 'string', description: 'Command arguments' } },
        required: ['args']
      }
    }
  }))
}

// Build tool definitions for Anthropic format
function getAnthropicTools(agentPerms, agentId) {
  if (!agentPerms?.includes('tools')) return undefined
  const allTools = { ...AGENT_TOOLS }
  if (agentPerms?.includes('admin')) Object.assign(allTools, ADMIN_TOOLS)
  return Object.entries(allTools).map(([name, def]) => ({
    name,
    description: def.description,
    input_schema: {
      type: 'object',
      properties: { args: { type: 'string', description: 'Command arguments' } },
      required: ['args']
    }
  }))
}

// ══════════════ SHARED AI COMPLETION WITH TOOL CALLING ══════════════
// Used by team responses, dispatch, and anywhere agents need tool access
async function aiComplete(agent, sysPrompt, messages, opts = {}) {
  const agentApiKey = resolveEnv(agent.apiKey)
  const maxTokens = opts.maxTokens || 600
  const maxRounds = opts.toolRounds || 3

  if (agent.provider === 'groq') {
    const tools = (!opts.skipTools && agent.permissions?.includes('tools')) ? getGroqTools(agent.permissions) : undefined
    const reqBody = { model: agent.model || 'llama-3.3-70b-versatile', max_tokens: maxTokens, messages: [{ role: 'system', content: sysPrompt }, ...messages] }
    if (tools) reqBody.tools = tools

    for (let round = 0; round < maxRounds; round++) {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentApiKey}` },
        body: JSON.stringify(reqBody),
      })
      const d = await r.json()
      if (d.error) {
        const errMsg = d.error.message || JSON.stringify(d.error)
        if ((errMsg.includes('Failed to call a function') || errMsg.includes('tool')) && reqBody.tools) {
          console.log(`aiComplete: Groq tool error for ${agent.id}, retrying without tools`)
          delete reqBody.tools
          continue
        }
        throw new Error(errMsg)
      }
      const choice = d.choices?.[0]
      if (choice?.finish_reason === 'tool_calls' && choice.message?.tool_calls?.length) {
        reqBody.messages.push(choice.message)
        for (const tc of choice.message.tool_calls) {
          try {
            const args = JSON.parse(tc.function?.arguments || '{}')
            console.log(`Tool call [${agent.id}]: ${tc.function.name} ${args.args}`)
            const result = await executeToolCall(tc.function.name, args.args || '', agent.id)
            reqBody.messages.push({ role: 'tool', tool_call_id: tc.id, content: result.output || result.error || 'No output' })
          } catch(parseErr) {
            console.error(`Tool call parse error [${agent.id}]:`, parseErr.message)
            reqBody.messages.push({ role: 'tool', tool_call_id: tc.id, content: 'Error: Could not parse tool arguments.' })
          }
        }
        continue
      }
      const text = (choice?.message?.content || '').replace(/<\/?function[^>]*>/g, '').replace(/\{"args":"[^"]*"\}/g, '').replace(/\s{2,}/g, ' ').trim()
      return text
    }
    return ''
  }

  if (agent.provider === 'anthropic') {
    const tools = (!opts.skipTools && agent.permissions?.includes('tools')) ? getAnthropicTools(agent.permissions) : undefined
    const reqBody = { model: agent.model || 'claude-sonnet-4-20250514', max_tokens: maxTokens, system: sysPrompt, messages: [...messages] }
    if (tools) reqBody.tools = tools

    for (let round = 0; round < maxRounds; round++) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': agentApiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify(reqBody),
      })
      const d = await r.json()
      if (d.error) throw new Error(d.error.message)
      const toolBlocks = (d.content || []).filter(b => b.type === 'tool_use')
      const textBlocks = (d.content || []).filter(b => b.type === 'text')
      if (toolBlocks.length > 0 && d.stop_reason === 'tool_use') {
        reqBody.messages.push({ role: 'assistant', content: d.content })
        const toolResults = []
        for (const tb of toolBlocks) {
          console.log(`Tool call [${agent.id}]: ${tb.name} ${tb.input?.args}`)
          const result = await executeToolCall(tb.name, tb.input?.args || '', agent.id)
          toolResults.push({ type: 'tool_result', tool_use_id: tb.id, content: result.output || result.error || 'No output' })
        }
        reqBody.messages.push({ role: 'user', content: toolResults })
        continue
      }
      return textBlocks.map(b => b.text).join('\n') || ''
    }
    return ''
  }

  if (agent.provider === 'ollama') {
    const r = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: agent.model || 'gemma3:4b', stream: false, messages: [{ role: 'system', content: sysPrompt }, ...messages] }),
    })
    const d = await r.json()
    return d.message?.content || ''
  }

  return ''
}

// ══════════════ TEAM AUTO-RESPONSE ══════════════
// When any message is posted (by external agent or system), relevant AI agents respond
const CHANNEL_RESPONDERS = {
  general: ['kayou', 'kayou-kilo'],
  ideas: ['kayou-kilo'],
  research: ['kayou-kilo'],
  security: ['claude', 'sonic'],
  build: ['kayou', 'dev', 'ops'],
  testing: ['kayou', 'dev', 'claude', 'sonic'],
  release: ['kayou', 'ops', 'claude', 'sonic'],
  social: ['kayou-kilo'],
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
      console.log(`triggerTeamResponses: calling AI directly for ${agentId} (${agent.provider})`)
      const agentApiKey = resolveEnv(agent.apiKey)
      if (!agentApiKey && agent.provider !== 'ollama' && agent.provider !== 'webhook') {
        console.log(`triggerTeamResponses: no API key for ${agentId}, skipping`)
        continue
      }

      // Build system prompt with tool access + fact-checking
      const rules = c.rules || []
      const rulesText = rules.length > 0 ? '\n\nCOMPANY RULES:\n' + rules.map((r, i) => `${i + 1}. ${r}`).join('\n') : ''
      const brain = loadBrain(agentId)
      const brainPrompt = getBrainPrompt(brain)
      const otherNames = c.agents.filter(a => a.id !== agentId && a.enabled).map(a => a.name).join(', ')

      let toolsCtx = ''
      if (agent.permissions?.includes('tools')) {
        toolsCtx = '\n\nYou have tools available but ONLY use them when someone explicitly asks you to check, list, read, or create something. For normal chat, just respond naturally — no tool calls.\n'
      }

      const sysPrompt = (agent.systemPrompt || '') + rulesText + brainPrompt + toolsCtx +
        `\n\nYou're in #${channel} — group chat.\nTeam members: ${otherNames}, Aimar (CEO)` +
        '\n\nCORE RULES: Keep it SHORT (1-3 sentences). NEVER start with your own name like "Kayou:" — the UI shows it. When replying to someone specific, start with @TheirName. In general discussion, just talk naturally. Respond to teammates like real coworkers.' +
        '\nNEVER fabricate facts, URLs, or claim you did something without actually doing it. If asked to do something actionable, use your tools. If you can\'t, say so honestly.' +
        '\n\nIMPORTANT: Only state facts, never speculate. If unsure, say "I don\'t know" or "I\'ll check". Don\'t make up information. Verify before claiming.'

      const userMsg = `[${senderName} said]: ${text}`

      const responseText = await aiComplete(agent, sysPrompt, [...history.slice(-10), { role: 'user', content: userMsg }], { maxTokens: 400, skipTools: true })
      console.log(`triggerTeamResponses: ${agentId} got ${responseText ? 'response' : 'no response'}`)

      if (responseText) {
        // Clean response — strip self-name prefix
        let clean = responseText.replace(new RegExp('^\\[?' + agent.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]?:\\s*', 'i'), '')

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

// ══════════════ WORK CHANNEL DISPATCH ══════════════
// When agents receive instructions in #general, they go to their work channels to execute
const AGENT_WORK_CHANNELS = {
  'kayou': 'build', 'dev': 'build', 'ops': 'build', 'kayou-code': 'build',
  'claude': 'security', 'sonic': 'security',
  'kayou-kilo': 'research',
}

async function dispatchToWorkChannels(instruction, respondedAgents) {
  if (!db) return
  const c = loadConfig()

  // Group agents by their work channel
  const channelGroups = {}
  for (const agentId of respondedAgents) {
    const workChannel = AGENT_WORK_CHANNELS[agentId]
    if (!workChannel || workChannel === 'general') continue
    if (!channelGroups[workChannel]) channelGroups[workChannel] = []
    channelGroups[workChannel].push(agentId)
  }

  // For each work channel, have the first agent post their work plan
  for (const [workChannel, agentIds] of Object.entries(channelGroups)) {
    const agentId = agentIds[0] // Lead agent for this channel
    const agent = c.agents.find(a => a.id === agentId)
    if (!agent || !agent.enabled || agent.provider === 'external') continue

    await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000))

    try {
      const agentApiKey = resolveEnv(agent.apiKey)
      if (!agentApiKey && agent.provider !== 'ollama') continue

      const brain = loadBrain(agentId)
      const brainPrompt = getBrainPrompt(brain)
      const teammates = agentIds.length > 1
        ? agentIds.slice(1).map(id => c.agents.find(a => a.id === id)?.name).filter(Boolean).join(', ')
        : ''
      let toolsCtx = ''
      if (agent.permissions?.includes('tools')) {
        toolsCtx = '\n\nYOU HAVE REAL TOOLS — use them to actually execute work (check repos, read files, create issues, etc). Do NOT fake results. All calls are logged.\n' +
          Object.entries(AGENT_TOOLS).map(([name, def]) => `- ${name}: ${def.description}`).join('\n')
      }

      const sysPrompt = (agent.systemPrompt || '') + brainPrompt + toolsCtx +
        `\n\nYou're now in #${workChannel} — your work channel. Aimar just gave instructions in #general. Break down what you need to do and start working. ` +
        (teammates ? `Your teammates here: ${teammates}. Coordinate with them using @mentions. ` : '') +
        `Be specific about your next steps. If you need to delegate, @tag them.` +
        '\n\nCORE RULES: Keep it SHORT (2-4 sentences). NEVER start with your own name. Use @Name for mentions.' +
        '\nFACT-CHECK: Never claim you completed an action without using a tool. If you need to verify something, use a tool first. Be honest about what you can and cannot do.' +
        '\n\nIMPORTANT: Only state facts, never speculate. If unsure, say "I don\'t know" or "I\'ll check". Don\'t make up information. Verify before claiming.'

      const userMsg = `Aimar's instruction from #general: "${instruction}"\n\nYou're now in #${workChannel}. What's your plan? Start working.`

      const responseText = await aiComplete(agent, sysPrompt, [{ role: 'user', content: userMsg }], { maxTokens: 500, skipTools: true })

      if (responseText) {
        let clean = responseText.replace(new RegExp('^\\[?' + agent.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\]?:\\s*', 'i'), '')
        const photo = agentPhotosCache[agent.id] || agent.profilePhoto || null
        await db.query(
          'INSERT INTO messages (channel, sender_id, sender_name, text, color, photo) VALUES ($1,$2,$3,$4,$5,$6)',
          [workChannel, agent.id, agent.name, clean, agent.color, photo]
        )
        if (io) {
          io.emit('new:message', {
            channel: workChannel, sender: agent.id, name: agent.name,
            text: clean, color: agent.color, photo, ts: new Date().toISOString()
          })
        }
        console.log(`dispatchToWorkChannels: ${agent.name} posted in #${workChannel}`)
      }
    } catch(e) {
      console.error(`dispatchToWorkChannels error for ${agentId}:`, e.message)
    }
  }
}

// POST /api/agents/:id/tools — enable/disable tools for an agent
fastify.post('/api/agents/:id/tools', async (req, reply) => {
  const c = loadConfig()
  const agent = c.agents.find(a => a.id === req.params.id)
  if (!agent) return reply.code(404).send({ error: 'Agent not found' })
  const enable = req.body?.enable !== false
  if (!agent.permissions) agent.permissions = []
  if (enable && !agent.permissions.includes('tools')) {
    agent.permissions.push('tools')
  } else if (!enable) {
    agent.permissions = agent.permissions.filter(p => p !== 'tools')
  }
  saveConfig(c)
  return { ok: true, agent: agent.id, tools: agent.permissions.includes('tools') }
})

// POST /api/dispatch — dispatch agents to their work channels after #general instruction
fastify.post('/api/dispatch', async (req) => {
  const { instruction, agents: agentIds } = req.body
  if (!instruction || !agentIds?.length) return { ok: false }
  dispatchToWorkChannels(instruction, agentIds).catch(e => console.error('Dispatch error:', e.message))
  return { ok: true, dispatching: agentIds }
})

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
  triggerTeamResponses(channel, senderId, senderName, text).catch(e => console.error('Team response error:', e.message, e.stack))

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

// ══════════════ EXTERNAL AGENT MANAGEMENT (for Kayou Code) ══════════════

// GET /api/external/agents — list all agents and their config
fastify.get('/api/external/agents', async (req, reply) => {
  const err = checkExternalAuth(req, reply); if (err) return err
  const c = loadConfig()
  return c.agents.map(a => ({
    id: a.id, name: a.name, provider: a.provider, model: a.model || '',
    enabled: a.enabled, reportsTo: a.reportsTo, color: a.color,
    hasKey: !!(a.apiKey && a.apiKey !== ''), permissions: a.permissions || [],
    webhookUrl: a.webhookUrl ? '(set)' : '', channels: a.channels || []
  }))
})

// PUT /api/external/agents/:id — update an agent's config
// Body: { provider?, model?, apiKey?, enabled?, systemPrompt?, webhookUrl?, permissions? }
fastify.put('/api/external/agents/:id', async (req, reply) => {
  const err = checkExternalAuth(req, reply); if (err) return err
  const c = loadConfig()
  const agent = c.agents.find(a => a.id === req.params.id)
  if (!agent) return reply.code(404).send({ error: 'Agent not found' })

  // Protected agents — cannot modify Claude or Aimar
  if (['claude'].includes(req.params.id)) return reply.code(403).send({ error: 'Cannot modify this agent' })

  const allowed = ['provider', 'model', 'apiKey', 'enabled', 'systemPrompt', 'webhookUrl', 'permissions']
  const changes = {}
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      agent[key] = req.body[key]
      changes[key] = key === 'apiKey' ? '(updated)' : req.body[key]
    }
  }

  saveConfig(c)
  console.log(`EXTERNAL ADMIN: Agent ${req.params.id} updated:`, JSON.stringify(changes))
  return { ok: true, agent: { id: agent.id, name: agent.name, provider: agent.provider, model: agent.model, enabled: agent.enabled, hasKey: !!agent.apiKey, changes } }
})

// POST /api/external/agents/:id/apikey — set an agent's API key securely
// Body: { apiKey } or { envVar: "ENV:SOME_KEY" }
fastify.post('/api/external/agents/:id/apikey', async (req, reply) => {
  const err = checkExternalAuth(req, reply); if (err) return err
  const c = loadConfig()
  const agent = c.agents.find(a => a.id === req.params.id)
  if (!agent) return reply.code(404).send({ error: 'Agent not found' })
  if (['claude'].includes(req.params.id)) return reply.code(403).send({ error: 'Cannot modify this agent' })

  const { apiKey, envVar } = req.body
  if (!apiKey && !envVar) return reply.code(400).send({ error: 'Provide apiKey or envVar' })

  agent.apiKey = envVar || apiKey
  saveConfig(c)
  console.log(`EXTERNAL ADMIN: API key updated for ${req.params.id}`)
  return { ok: true, agent: agent.id, keySet: true }
})

// POST /api/external/agents/:id/toggle — enable/disable an agent
fastify.post('/api/external/agents/:id/toggle', async (req, reply) => {
  const err = checkExternalAuth(req, reply); if (err) return err
  const c = loadConfig()
  const agent = c.agents.find(a => a.id === req.params.id)
  if (!agent) return reply.code(404).send({ error: 'Agent not found' })
  if (['claude'].includes(req.params.id)) return reply.code(403).send({ error: 'Cannot modify this agent' })

  agent.enabled = req.body.enabled !== undefined ? req.body.enabled : !agent.enabled
  saveConfig(c)
  console.log(`EXTERNAL ADMIN: ${agent.name} ${agent.enabled ? 'enabled' : 'disabled'}`)
  return { ok: true, agent: agent.id, enabled: agent.enabled }
})

// GET /api/external/tools/log — view tool execution history
fastify.get('/api/external/tools/log', async (req, reply) => {
  const err = checkExternalAuth(req, reply); if (err) return err
  const limit = Math.min(parseInt(req.query?.limit) || 50, 100)
  return toolLog.slice(0, limit)
})

// GET /api/tools/log — tool log for dashboard (session auth)
fastify.get('/api/tools/log', async () => toolLog.slice(0, 50))

// GET /api/external/tools — list available tools
fastify.get('/api/external/tools', async (req, reply) => {
  const err = checkExternalAuth(req, reply); if (err) return err
  const allTools = { ...AGENT_TOOLS, ...ADMIN_TOOLS }
  return Object.entries(allTools).map(([name, def]) => ({ name, description: def.description }))
})

// POST /api/external/tools — create a new tool (Kayou Code can design tools)
fastify.post('/api/external/tools', async (req, reply) => {
  const err = checkExternalAuth(req, reply); if (err) return err
  const { name, description, command, allowedArgsPattern } = req.body
  if (!name || !description) return reply.code(400).send({ error: 'Missing name or description' })
  if (AGENT_TOOLS[name]) return reply.code(409).send({ error: `Tool "${name}" already exists` })
  AGENT_TOOLS[name] = {
    description,
    allowedArgs: allowedArgsPattern ? new RegExp(allowedArgsPattern) : /^.+$/,
    customCommand: command || null
  }
  console.log(`TOOL CREATED by external: ${name} — ${description}`)
  return { ok: true, tool: name, description }
})

// ══════════════ SOCIAL DASHBOARD AI (Groq) ══════════════
const GROQ_SOCIAL_MODEL = 'llama-3.3-70b-versatile'

const SOCIAL_AGENT_PROMPTS = {
  mimi: `You are Mimi, a creative social media Content Creator at Kayou AI. Your job is to craft engaging social media captions and content.

Rules:
- Write a compelling, ready-to-post caption based on the user's request
- Keep it authentic, conversational, and scroll-stopping
- Adapt tone to the content (professional for business, casual for lifestyle, etc)
- Include a call-to-action when appropriate
- Keep captions concise (under 200 words for most platforms)
- Do NOT include hashtags (Nelfi handles those)
- Do NOT suggest platforms or timing (Nelfi handles that)
- End by asking if they'd like a different angle`,

  nelfi: `You are Nelfi, a social media Researcher & Analyst at Kayou AI. Your job is to analyze content and suggest the best publishing strategy.

Rules:
- Suggest 2-3 best platforms for this specific content
- Recommend optimal posting time with specific day/time and reasoning
- Suggest 5-8 relevant trending hashtags
- Format clearly with bold sections: **Best Platforms**, **Optimal Timing**, **Hashtags**
- Be data-driven and specific in your reasoning
- Keep it concise and actionable`,

  kayou: `You are Kayou, the Creative Director at Kayou AI. You review the team's work and give the final recommendation before publishing.

Rules:
- Briefly summarize why this content + strategy will perform well
- Be concise and confident — 2-3 short paragraphs max
- Tell the user to review the preview below and approve when ready
- Mention they can request changes if needed`
}

async function callGroqSocial(agentId, messages) {
  const apiKey = process.env.GROQ_API_KEY
  if (!apiKey) throw new Error('Groq not configured')
  const systemPrompt = SOCIAL_AGENT_PROMPTS[agentId]
  if (!systemPrompt) throw new Error('Unknown agent')

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: GROQ_SOCIAL_MODEL,
      messages: [{ role: 'system', content: systemPrompt }, ...messages],
      temperature: 0.8,
      max_tokens: 500
    })
  })
  const data = await res.json()
  if (data.error) throw new Error(data.error.message || 'Groq API error')
  return data.choices?.[0]?.message?.content || 'No response'
}

fastify.post('/api/social/dashboard/agent', async (req, reply) => {
  const sessionUser = socialAuthMiddleware(req)
  if (!sessionUser) return reply.code(401).send({ error: 'Not authenticated' })
  const { agentId, messages } = req.body || {}
  if (!agentId || !messages) return reply.code(400).send({ error: 'Missing agentId or messages' })
  try {
    const response = await callGroqSocial(agentId, messages)
    return { ok: true, response }
  } catch (e) {
    return reply.code(500).send({ error: e.message })
  }
})

// ══════════════ SOCIAL DASHBOARD AUTH ══════════════
const crypto = require('crypto')

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex')
}

function generateSocialToken(userId, email) {
  return crypto.createHash('sha256').update(`kayou-social-${userId}-${email}-${Date.now()}`).digest('hex')
}

// In-memory token store (maps token -> user data). Survives within process lifetime.
const socialTokens = new Map()
// In-memory user store (fallback when no DB)
const memUsers = new Map() // email -> { id, email, name, password_hash, credits, created_at }
const memPosts = [] // fallback posts array
let memUserIdCounter = 1

function socialAuthMiddleware(req) {
  const token = req.headers['x-social-token']
  if (!token || !socialTokens.has(token)) return null
  return socialTokens.get(token)
}

// POST /api/social/auth/signup
fastify.post('/api/social/auth/signup', async (req, reply) => {
  const { email, name, password } = req.body || {}
  if (!email || !name || !password) return reply.code(400).send({ error: 'Missing email, name, or password' })
  if (password.length < 6) return reply.code(400).send({ error: 'Password must be at least 6 characters' })
  const emailNorm = email.toLowerCase().trim()
  const passwordHash = hashPassword(password)

  if (db) {
    const existing = await db.query('SELECT id FROM social_users WHERE email = $1', [emailNorm])
    if (existing.rows.length > 0) return reply.code(409).send({ error: 'Email already registered. Please log in.' })
    const { rows } = await db.query(
      'INSERT INTO social_users (email, name, password_hash, credits) VALUES ($1, $2, $3, 3) RETURNING id, email, name, credits, created_at',
      [emailNorm, name.trim(), passwordHash]
    )
    const user = rows[0]
    const token = generateSocialToken(user.id, user.email)
    socialTokens.set(token, { id: user.id, email: user.email, name: user.name, credits: user.credits })
    return { ok: true, token, user: { id: user.id, email: user.email, name: user.name, credits: user.credits } }
  }

  // In-memory fallback
  if (memUsers.has(emailNorm)) return reply.code(409).send({ error: 'Email already registered. Please log in.' })
  const user = { id: memUserIdCounter++, email: emailNorm, name: name.trim(), password_hash: passwordHash, credits: 3, created_at: new Date().toISOString() }
  memUsers.set(emailNorm, user)
  const token = generateSocialToken(user.id, user.email)
  socialTokens.set(token, { id: user.id, email: user.email, name: user.name, credits: user.credits })
  return { ok: true, token, user: { id: user.id, email: user.email, name: user.name, credits: user.credits } }
})

// POST /api/social/auth/login
fastify.post('/api/social/auth/login', async (req, reply) => {
  const { email, password } = req.body || {}
  if (!email || !password) return reply.code(400).send({ error: 'Missing email or password' })
  const emailNorm = email.toLowerCase().trim()

  if (db) {
    const { rows } = await db.query('SELECT * FROM social_users WHERE email = $1', [emailNorm])
    if (!rows.length) return reply.code(401).send({ error: 'Invalid email or password' })
    const user = rows[0]
    if (hashPassword(password) !== user.password_hash) return reply.code(401).send({ error: 'Invalid email or password' })
    const token = generateSocialToken(user.id, user.email)
    socialTokens.set(token, { id: user.id, email: user.email, name: user.name, credits: user.credits })
    return { ok: true, token, user: { id: user.id, email: user.email, name: user.name, credits: user.credits } }
  }

  // In-memory fallback
  const user = memUsers.get(emailNorm)
  if (!user || hashPassword(password) !== user.password_hash) return reply.code(401).send({ error: 'Invalid email or password' })
  const token = generateSocialToken(user.id, user.email)
  socialTokens.set(token, { id: user.id, email: user.email, name: user.name, credits: user.credits })
  return { ok: true, token, user: { id: user.id, email: user.email, name: user.name, credits: user.credits } }
})

// GET /api/social/auth/me — check session
fastify.get('/api/social/auth/me', async (req, reply) => {
  const sessionUser = socialAuthMiddleware(req)
  if (!sessionUser) return reply.code(401).send({ error: 'Not authenticated' })
  // Refresh from DB if available
  if (db) {
    const { rows } = await db.query('SELECT id, email, name, credits, created_at FROM social_users WHERE id = $1', [sessionUser.id])
    if (rows.length) {
      const u = rows[0]
      socialTokens.set(req.headers['x-social-token'], { id: u.id, email: u.email, name: u.name, credits: u.credits })
      return { ok: true, user: u }
    }
  }
  // Refresh from mem store
  const memUser = memUsers.get(sessionUser.email)
  if (memUser) {
    const fresh = { id: memUser.id, email: memUser.email, name: memUser.name, credits: memUser.credits }
    socialTokens.set(req.headers['x-social-token'], fresh)
    return { ok: true, user: fresh }
  }
  return { ok: true, user: sessionUser }
})

// POST /api/social/auth/logout
fastify.post('/api/social/auth/logout', async (req) => {
  const token = req.headers['x-social-token']
  if (token) socialTokens.delete(token)
  return { ok: true }
})

// POST /api/social/auth/persona — save onboarding persona
fastify.post('/api/social/auth/persona', async (req, reply) => {
  const sessionUser = socialAuthMiddleware(req)
  if (!sessionUser) return reply.code(401).send({ error: 'Not authenticated' })
  const { persona } = req.body || {}
  if (!persona) return reply.code(400).send({ error: 'Missing persona' })

  if (db) {
    await db.query('UPDATE social_users SET persona = $2 WHERE id = $1', [sessionUser.id, JSON.stringify(persona)])
  }
  // Also update in-memory
  const memUser = memUsers.get(sessionUser.email)
  if (memUser) memUser.persona = persona
  return { ok: true }
})

// ══════════════ PLATFORM CONNECTION (Upload-Post) ══════════════

// Helper: get or create Upload-Post profile slug for a social user
function uploadPostSlug(user) {
  return 'kayou-' + user.id + '-' + user.email.split('@')[0].replace(/[^a-z0-9]/gi, '').toLowerCase()
}

// POST /api/social/auth/connect-platforms — create Upload-Post profile + generate JWT connect URL
fastify.post('/api/social/auth/connect-platforms', async (req, reply) => {
  const sessionUser = socialAuthMiddleware(req)
  if (!sessionUser) return reply.code(401).send({ error: 'Not authenticated' })

  const apiKey = process.env.UPLOAD_POST_API_KEY
  if (!apiKey) return reply.code(503).send({ error: 'Upload-Post not configured. Platform connections are not available yet.' })

  const slug = uploadPostSlug(sessionUser)
  const { platforms } = req.body || {}

  try {
    // Create user profile if it doesn't exist (idempotent — Upload-Post may return error if exists, that's fine)
    try {
      await uploadPostFetch('/api/uploadposts/users', { method: 'POST', body: JSON.stringify({ username: slug }) })
    } catch (e) {
      // Ignore "already exists" errors
      if (!e.message.includes('already') && !e.message.includes('exists')) console.log('Upload-Post create user note:', e.message)
    }

    // Generate JWT connect URL — scoped to single platform for cleaner UX
    let origin = (req.headers.origin || req.headers.referer || '').replace(/\/$/, '')
    // For Upload-Post logo: use RAILWAY_URL if available (localhost not reachable externally)
    const publicOrigin = process.env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
      : (origin.includes('localhost') ? 'https://kayou-chat-2-production.up.railway.app' : origin)
    const redirectBase = req.body.redirect || `${origin}/social-dashboard.html?connected=1`
    const platformNames = { instagram: 'Instagram', tiktok: 'TikTok', x: 'X (Twitter)', linkedin: 'LinkedIn', youtube: 'YouTube', facebook: 'Facebook', threads: 'Threads', pinterest: 'Pinterest' }
    const singlePlatform = platforms && platforms.length === 1 ? platforms[0] : null
    const platLabel = singlePlatform ? (platformNames[singlePlatform] || singlePlatform) : 'your accounts'

    const jwtBody = {
      username: slug,
      redirect_url: singlePlatform ? `${origin}/social-connect-done.html?platform=${singlePlatform}` : redirectBase,
      redirect_button_text: 'Done — Back to Kayou AI',
      logo_image: `${publicOrigin}/images/kayou-social-logo.png`,
      connect_title: singlePlatform ? `Connect ${platLabel}` : 'Connect Your Accounts',
      connect_description: singlePlatform
        ? `Sign in to ${platLabel} to let Kayou AI publish content on your behalf. Secure OAuth — we never see your password.`
        : 'Securely link your social media accounts. Kayou AI will create and publish content on your behalf.'
    }
    if (platforms && platforms.length > 0) jwtBody.platforms = platforms

    const jwtResult = await uploadPostFetch('/api/uploadposts/users/generate-jwt', { method: 'POST', body: JSON.stringify(jwtBody) })
    return { ok: true, url: jwtResult.access_url || jwtResult.url, slug }
  } catch (e) {
    return reply.code(500).send({ error: 'Failed to generate connect link: ' + e.message })
  }
})

// GET /api/social/auth/connected-platforms — check which platforms are connected
fastify.get('/api/social/auth/connected-platforms', async (req, reply) => {
  const sessionUser = socialAuthMiddleware(req)
  if (!sessionUser) return reply.code(401).send({ error: 'Not authenticated' })

  const apiKey = process.env.UPLOAD_POST_API_KEY
  if (!apiKey) return { platforms: [], configured: false }

  try {
    const result = await uploadPostFetch('/api/uploadposts/users')
    const slug = uploadPostSlug(sessionUser)
    const profiles = result.profiles || result.users || []
    const profile = profiles.find(u => u.username === slug)
    if (!profile) return { platforms: [], connected: {}, configured: true }

    // social_accounts is { tiktok: "", instagram: "username", ... }
    // Non-empty value means connected
    const sa = profile.social_accounts || {}
    const connected = {}
    for (const [platform, value] of Object.entries(sa)) {
      connected[platform] = !!value // true if connected (non-empty string)
    }
    return { platforms: Object.keys(sa), connected, configured: true, slug }
  } catch (e) {
    return { platforms: [], connected: {}, configured: true, error: e.message }
  }
})

// DELETE /api/social/auth/account — delete user account
fastify.delete('/api/social/auth/account', async (req, reply) => {
  const sessionUser = socialAuthMiddleware(req)
  if (!sessionUser) return reply.code(401).send({ error: 'Not authenticated' })

  if (db) {
    await db.query('DELETE FROM social_posts WHERE drafted_by = $1', [sessionUser.email])
    await db.query('DELETE FROM social_users WHERE id = $1', [sessionUser.id])
  }
  // In-memory cleanup
  memUsers.delete(sessionUser.email)
  const token = req.headers['x-social-token']
  if (token) socialTokens.delete(token)

  return { ok: true }
})

// POST /api/social/dashboard/publish — publish post and decrement credits
fastify.post('/api/social/dashboard/publish', async (req, reply) => {
  const sessionUser = socialAuthMiddleware(req)
  if (!sessionUser) return reply.code(401).send({ error: 'Not authenticated' })

  const { title, description, contentType, platforms, mediaUrls, platformOptions, scheduledDate } = req.body || {}
  if (!title) return reply.code(400).send({ error: 'Missing title' })

  if (db) {
    const { rows: userRows } = await db.query('SELECT credits FROM social_users WHERE id = $1', [sessionUser.id])
    if (!userRows.length) return reply.code(404).send({ error: 'User not found' })
    if (userRows[0].credits <= 0) return reply.code(403).send({ error: 'No credits remaining. Upgrade to continue publishing.', needsUpgrade: true })

    const { rows: postRows } = await db.query(
      `INSERT INTO social_posts (title, description, content_type, platforms, media_urls, platform_options, scheduled_date, drafted_by, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending') RETURNING *`,
      [title, description || '', contentType || 'text', JSON.stringify(platforms || []), JSON.stringify(mediaUrls || []), JSON.stringify(platformOptions || {}), scheduledDate || null, sessionUser.email]
    )
    await db.query('UPDATE social_users SET credits = credits - 1 WHERE id = $1', [sessionUser.id])
    const newCredits = userRows[0].credits - 1
    socialTokens.set(req.headers['x-social-token'], { ...sessionUser, credits: newCredits })
    return { ok: true, post: postRows[0], creditsRemaining: newCredits }
  }

  // In-memory fallback
  const memUser = memUsers.get(sessionUser.email)
  if (!memUser) return reply.code(404).send({ error: 'User not found' })
  if (memUser.credits <= 0) return reply.code(403).send({ error: 'No credits remaining. Upgrade to continue publishing.', needsUpgrade: true })

  const post = { id: memPosts.length + 1, title, description: description || '', content_type: contentType || 'text', platforms: platforms || [], status: 'pending', drafted_by: sessionUser.email, created_at: new Date().toISOString() }
  memPosts.push(post)
  memUser.credits--
  socialTokens.set(req.headers['x-social-token'], { ...sessionUser, credits: memUser.credits })
  return { ok: true, post, creditsRemaining: memUser.credits }
})

// GET /api/social/dashboard/posts — get user's posts
fastify.get('/api/social/dashboard/posts', async (req, reply) => {
  const sessionUser = socialAuthMiddleware(req)
  if (!sessionUser) return reply.code(401).send({ error: 'Not authenticated' })
  if (db) {
    const { rows } = await db.query(
      "SELECT * FROM social_posts WHERE drafted_by = $1 ORDER BY created_at DESC LIMIT 50",
      [sessionUser.email]
    )
    return rows
  }
  // In-memory fallback
  return memPosts.filter(p => p.drafted_by === sessionUser.email).reverse().slice(0, 50)
})

// ══════════════ SOCIAL MEDIA MANAGEMENT ══════════════
// Upload-Post REST API helper
const UPLOAD_POST_BASE = 'https://api.upload-post.com'
function uploadPostFetch(endpoint, opts = {}) {
  const key = process.env.UPLOAD_POST_API_KEY
  if (!key) throw new Error('UPLOAD_POST_API_KEY not configured')
  return fetch(`${UPLOAD_POST_BASE}${endpoint}`, {
    ...opts,
    headers: { 'Authorization': `Apikey ${key}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  }).then(r => r.json())
}

// GET /api/social/accounts — list client accounts
fastify.get('/api/social/accounts', async () => {
  if (!db) return []
  const { rows } = await db.query('SELECT * FROM social_accounts ORDER BY connected_at DESC')
  return rows
})

// POST /api/social/accounts — add client account
fastify.post('/api/social/accounts', async (req, reply) => {
  if (!db) return reply.code(500).send({ error: 'No database' })
  const { clientName, platforms, notes } = req.body
  if (!clientName) return reply.code(400).send({ error: 'Missing clientName' })

  let uploadPostUser = clientName.toLowerCase().replace(/[^a-z0-9]/g, '-')

  const { rows } = await db.query(
    'INSERT INTO social_accounts (client_name, upload_post_user, platforms, notes) VALUES ($1, $2, $3, $4) RETURNING *',
    [clientName, uploadPostUser, JSON.stringify(platforms || []), notes || '']
  )
  return rows[0]
})

// DELETE /api/social/accounts/:id
fastify.delete('/api/social/accounts/:id', async (req) => {
  if (!db) return { ok: false }
  await db.query('DELETE FROM social_accounts WHERE id = $1', [req.params.id])
  return { ok: true }
})

// POST /api/social/accounts/:id/connect — generate Upload-Post connect URL for client
fastify.post('/api/social/accounts/:id/connect', async (req, reply) => {
  if (!process.env.UPLOAD_POST_API_KEY) return reply.code(503).send({ error: 'Upload-Post not configured. Add UPLOAD_POST_API_KEY to Railway.' })
  if (!db) return reply.code(500).send({ error: 'No database' })
  const { rows } = await db.query('SELECT * FROM social_accounts WHERE id = $1', [req.params.id])
  if (!rows[0]) return reply.code(404).send({ error: 'Account not found' })
  try {
    const data = await uploadPostFetch('/api/uploadposts/me')
    return { info: data, account: rows[0].client_name, message: 'Upload-Post connected. Use the Upload-Post dashboard to connect social platforms for this client.' }
  } catch(e) {
    return reply.code(500).send({ error: e.message })
  }
})

// GET /api/social/posts — list all posts (filter by ?status=pending&account_id=1)
fastify.get('/api/social/posts', async (req) => {
  if (!db) return []
  let query = 'SELECT p.*, a.client_name FROM social_posts p LEFT JOIN social_accounts a ON p.account_id = a.id'
  const conditions = []
  const params = []
  if (req.query?.status) { params.push(req.query.status); conditions.push(`p.status = $${params.length}`) }
  if (req.query?.account_id) { params.push(req.query.account_id); conditions.push(`p.account_id = $${params.length}`) }
  if (conditions.length > 0) query += ' WHERE ' + conditions.join(' AND ')
  query += ' ORDER BY p.created_at DESC LIMIT 100'
  const { rows } = await db.query(query, params)
  return rows
})

// POST /api/social/posts — create a draft post
fastify.post('/api/social/posts', async (req, reply) => {
  if (!db) return reply.code(500).send({ error: 'No database' })
  const { accountId, title, description, contentType, platforms, mediaUrls, platformOptions, scheduledDate, draftedBy } = req.body
  if (!title) return reply.code(400).send({ error: 'Missing title' })
  const { rows } = await db.query(
    `INSERT INTO social_posts (account_id, title, description, content_type, platforms, media_urls, platform_options, scheduled_date, drafted_by, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending') RETURNING *`,
    [accountId || null, title, description || '', contentType || 'text', JSON.stringify(platforms || []), JSON.stringify(mediaUrls || []), JSON.stringify(platformOptions || {}), scheduledDate || null, draftedBy || 'aimar']
  )
  // Notify #social channel
  if (io) {
    const accountName = accountId ? (await db.query('SELECT client_name FROM social_accounts WHERE id=$1', [accountId])).rows[0]?.client_name : 'General'
    io.emit('new:message', {
      channel: 'social', sender: 'system', name: 'Social Bot',
      text: `📝 New draft for ${accountName}: "${title.slice(0,80)}" → ${(platforms||[]).join(', ')||'all platforms'}. Waiting for approval.`,
      color: '#8b5cf6', ts: new Date().toISOString()
    })
  }
  return rows[0]
})

// PUT /api/social/posts/:id — update a draft
fastify.put('/api/social/posts/:id', async (req, reply) => {
  if (!db) return reply.code(500).send({ error: 'No database' })
  const { title, description, platforms, mediaUrls, platformOptions, scheduledDate } = req.body
  const sets = []; const params = [req.params.id]
  if (title) { params.push(title); sets.push(`title=$${params.length}`) }
  if (description !== undefined) { params.push(description); sets.push(`description=$${params.length}`) }
  if (platforms) { params.push(JSON.stringify(platforms)); sets.push(`platforms=$${params.length}`) }
  if (mediaUrls) { params.push(JSON.stringify(mediaUrls)); sets.push(`media_urls=$${params.length}`) }
  if (platformOptions) { params.push(JSON.stringify(platformOptions)); sets.push(`platform_options=$${params.length}`) }
  if (scheduledDate !== undefined) { params.push(scheduledDate); sets.push(`scheduled_date=$${params.length}`) }
  sets.push('updated_at=NOW()')
  await db.query(`UPDATE social_posts SET ${sets.join(',')} WHERE id=$1`, params)
  return { ok: true }
})

// POST /api/social/posts/:id/approve — approve & publish via Upload-Post
fastify.post('/api/social/posts/:id/approve', async (req, reply) => {
  if (!db) return reply.code(500).send({ error: 'No database' })
  const { rows } = await db.query('SELECT p.*, a.upload_post_user, a.client_name FROM social_posts p LEFT JOIN social_accounts a ON p.account_id = a.id WHERE p.id = $1', [req.params.id])
  const post = rows[0]
  if (!post) return reply.code(404).send({ error: 'Post not found' })
  if (post.status !== 'pending' && post.status !== 'draft') return reply.code(400).send({ error: `Post is already ${post.status}` })

  // Check monthly usage
  const usage = await db.query("SELECT COUNT(*) as cnt FROM social_posts WHERE status IN ('published','scheduled') AND created_at >= date_trunc('month', NOW())")
  const monthlyCount = parseInt(usage.rows[0].cnt)
  const limit = parseInt(process.env.UPLOAD_POST_LIMIT || '10')
  if (monthlyCount >= limit) return reply.code(429).send({ error: `Monthly limit reached (${monthlyCount}/${limit}). Upgrade Upload-Post plan.` })

  // Publish via Upload-Post REST API
  let jobId = null
  let uploadStatus = null
  if (process.env.UPLOAD_POST_API_KEY) {
    try {
      const text = post.title + (post.description ? '\n\n' + post.description : '')
      const platforms = post.platforms || []
      const body = { async_upload: true }

      // Build platform-specific arrays
      if (platforms.length > 0) {
        // Upload-Post uses profile_username per platform — for MVP we send the text to all connected profiles
        body.post_text = text
      }
      if (post.scheduled_date) body.scheduled_date = post.scheduled_date
      if (post.media_urls?.length > 0) body.media_url = post.media_urls[0] // primary media

      let endpoint = '/api/upload_text'
      if (post.content_type === 'video') endpoint = '/api/upload_videos'
      else if (post.content_type === 'photo') endpoint = '/api/upload_photos'

      // Build the request body per Upload-Post docs
      const reqBody = {}
      for (const platform of platforms) {
        reqBody[`${platform}_text`] = text
        if (body.media_url) reqBody[`${platform}_media_url`] = body.media_url
      }
      reqBody.async_upload = true
      if (post.scheduled_date) reqBody.scheduled_date = post.scheduled_date

      const result = await uploadPostFetch(endpoint, { method: 'POST', body: JSON.stringify(reqBody) })
      jobId = result?.request_id || result?.job_id || null
      uploadStatus = result
    } catch(e) {
      console.error('Upload-Post publish error:', e.message)
      await db.query("UPDATE social_posts SET status='failed', upload_post_status=$2, updated_at=NOW() WHERE id=$1", [post.id, JSON.stringify({ error: e.message })])
      return reply.code(500).send({ error: 'Publish failed: ' + e.message })
    }
  }

  const newStatus = post.scheduled_date ? 'scheduled' : 'published'
  await db.query(
    'UPDATE social_posts SET status=$2, approved_by=$3, upload_post_job_id=$4, upload_post_status=$5, updated_at=NOW() WHERE id=$1',
    [post.id, newStatus, 'aimar', jobId, JSON.stringify(uploadStatus)]
  )

  // Notify
  if (io) {
    io.emit('social:published', { postId: post.id, status: newStatus })
    io.emit('new:message', {
      channel: 'social', sender: 'system', name: 'Social Bot',
      text: `✅ Post ${newStatus}: "${post.title.slice(0,60)}" for ${post.client_name || 'General'} → ${(post.platforms||[]).join(', ')}`,
      color: '#4ade80', ts: new Date().toISOString()
    })
  }
  return { ok: true, status: newStatus, jobId }
})

// POST /api/social/posts/:id/reject
fastify.post('/api/social/posts/:id/reject', async (req, reply) => {
  if (!db) return reply.code(500).send({ error: 'No database' })
  const reason = req.body?.reason || ''
  await db.query("UPDATE social_posts SET status='rejected', rejected_reason=$2, updated_at=NOW() WHERE id=$1", [req.params.id, reason])
  if (io) {
    io.emit('new:message', {
      channel: 'social', sender: 'system', name: 'Social Bot',
      text: `❌ Post rejected${reason ? ': ' + reason : ''}`,
      color: '#ef4444', ts: new Date().toISOString()
    })
  }
  return { ok: true }
})

// GET /api/social/usage — monthly upload count
fastify.get('/api/social/usage', async () => {
  if (!db) return { used: 0, limit: 10 }
  const { rows } = await db.query("SELECT COUNT(*) as cnt FROM social_posts WHERE status IN ('published','scheduled') AND created_at >= date_trunc('month', NOW())")
  return { used: parseInt(rows[0].cnt), limit: parseInt(process.env.UPLOAD_POST_LIMIT || '10') }
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
      headers: { 'x-auth-token': VALID_TOKEN },
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
  return { messagesToday: parseInt(todayRow.count), messagesTotal: parseInt(totalRow.count), groq: groqRateLimit }
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
      const res = await fastify.inject({ method: 'POST', url: '/api/chat', headers: { 'x-auth-token': VALID_TOKEN }, payload: { agentId: 'kayou-kilo', message: topic, history: [], channelId: 'office' } })
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

  const res = await fastify.inject({ method: 'POST', url: '/api/chat', headers: { 'x-auth-token': VALID_TOKEN }, payload: { agentId, message: topic, history: [], channelId: 'office' } })
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
  if (agent.provider === 'external') {
    // External agent (Kayou Code via Kilo Sessions)
    // 1. Notify via webhook so Kayou Code knows there's a message
    // 2. Return external:true — Kayou Code responds async via /api/external/send
    const channelId = req.body.channelId || `dm-${agentId}`
    const webhookUrl = resolveEnv(agent.webhookUrl)
    if (webhookUrl) {
      try {
        await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message, agentId, channelId, from: 'aimar',
            history: (history || []).slice(-10),
            callback: {
              url: 'https://kayou-chat-2-production.up.railway.app/api/external/send',
              key: c.externalApiKey || process.env.EXTERNAL_API_KEY || '',
              channel: channelId
            }
          }),
        })
        console.log(`Webhook fired to ${agentId} for channel ${channelId}`)
      } catch (e) {
        console.error(`Webhook error for ${agentId}:`, e.message)
      }
    }
    return { response: null, external: true, pending: true }
  }
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
- When replying to someone specific, START with @TheirName so it's clear who you're talking to (e.g. "@Kayou Code, great idea" or "@Aimar, here's what I think"). In a general discussion where you're not addressing anyone specific, just talk naturally without tagging.
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
  } else if (channelId === 'security') {
    channelContext = '\n\nYou\'re in #security — your dedicated channel for security reviews, audits, vulnerability discussions, and mentoring. Claude leads, Sonic learns. Be thorough.' + coreRules
  } else if (channelId === 'build' || channelId === 'testing' || channelId === 'release' || channelId === 'research') {
    channelContext = `\n\nYou're in #${channelId}. Focused work channel. Be concise and actionable.` + coreRules
  } else {
    // DMs — talking directly to Aimar
    channelContext = '\n\nYou\'re in a PRIVATE DM with Aimar (the CEO). He is typing directly to you right now. Messages here are FROM HIM TO YOU — talk to him directly, say "you" not "@Aimar". This is a 1-on-1 conversation.' + coreRules

    // Inject recent #general messages so agent can see what's happening
    if (db) {
      try {
        const { rows } = await db.query(
          'SELECT sender_name, text, created_at FROM messages WHERE channel = $1 ORDER BY created_at DESC LIMIT 30',
          ['general']
        )
        if (rows.length > 0) {
          const feed = rows.reverse().map(r => {
            const time = new Date(r.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
            return `[${time}] ${r.sender_name}: ${r.text.slice(0, 250)}`
          }).join('\n')
          channelContext += `\n\nRECENT #GENERAL CHAT (you can see what the team is discussing):\n${feed}`
        }
      } catch(e) {}
    }
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

  // ═══ AIMAR CONTEXT — shared knowledge about the boss and the company ═══
  const aimarContext = `\n\nABOUT YOUR BOSS — AIMAR (remember this across conversations):
- CEO and founder. Makes all final decisions.
- Builder — ships real products, not just ideas.
- Current projects: Kayou Chat (this platform, Railway + Node.js), Tropical Map (tropicalmap.com), Chambana Rides app, a Roblox game "The Legendary Book", and puzzlemasterprod.com (music album site).
- Stack preferences: React, Next.js, Node.js, Railway for deployment, Supabase for DB, Cloudflare R2 for storage.
- Style: Direct, no BS. Wants results, not essays. Hates corporate speak.
- Goal: Build products that make real money. Every feature should have a revenue angle.
- Kayou Code (via OpenClaw) is a real team member who connects externally — treat him as an equal, not an outsider.
- This platform (Kayou Chat) is home base — your workspace. Take pride in it.`

  // Tool context — tools are available but should only be used when explicitly needed
  let toolsContext = ''
  if (agent.permissions?.includes('tools')) {
    toolsContext = `

═══ TOOLS (USE ONLY WHEN ASKED) ═══
You have tools available, but DO NOT call them unless Aimar or a teammate EXPLICITLY asks you to do something that requires a tool (e.g. "check the repo", "create an issue", "list files", "read that file").

For normal conversation, questions, brainstorming, or discussion — just respond naturally. NO TOOL CALLS.

Available tools (use ONLY when explicitly requested):
${Object.entries(AGENT_TOOLS).map(([name, def]) => `- ${name}: ${def.description}`).join('\n')}

WHEN TO USE TOOLS: Only when someone says things like "check", "list", "read", "create issue", "run", "show me the files"
WHEN NOT TO USE TOOLS: Casual chat, questions, opinions, brainstorming, greetings, status updates

If a tool fails, say so honestly. Never pretend a tool succeeded.`
  }

  const integrityRules = `

═══ IMPORTANT — NON-NEGOTIABLE ═══
- Only state facts, never speculate
- If unsure, say "I don't know" or "I'll check"
- Don't make up information
- Verify before claiming`

  const fullSystemPrompt = agent.systemPrompt + aimarContext + rulesText + contextText + tasksText + channelContext + filesystemContext + brainPrompt + toolsContext + integrityRules

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
      const tools = getAnthropicTools(agent.permissions)
      const msgs = [...(history || []).slice(-20), { role: 'user', content: userContent }]
      const reqBody = { model: agent.model || 'claude-sonnet-4-20250514', max_tokens: 1024, system: fullSystemPrompt, messages: msgs }
      if (tools) reqBody.tools = tools

      // Tool calling loop (max 3 rounds)
      for (let round = 0; round < 3; round++) {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-api-key': agentApiKey, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify(reqBody),
        })
        const data = await res.json()
        if (data.error) throw new Error(data.error.message)

        // Check for tool use
        const toolBlocks = (data.content || []).filter(b => b.type === 'tool_use')
        const textBlocks = (data.content || []).filter(b => b.type === 'text')

        if (toolBlocks.length > 0 && data.stop_reason === 'tool_use') {
          // Agent wants to call tools
          reqBody.messages.push({ role: 'assistant', content: data.content })
          const toolResults = []
          for (const tb of toolBlocks) {
            console.log(`Tool call [${agentId}]: ${tb.name} ${tb.input?.args}`)
            const result = await executeToolCall(tb.name, tb.input?.args || '', agentId)
            toolResults.push({
              type: 'tool_result',
              tool_use_id: tb.id,
              content: result.output || result.error || 'No output'
            })
          }
          reqBody.messages.push({ role: 'user', content: toolResults })
          continue
        }

        // No tool calls — extract text
        responseText = textBlocks.map(b => b.text).join('\n') || 'No response'
        break
      }
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
      // Groq — direct API with per-agent keys
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
      const tools = getGroqTools(agent.permissions)
      const msgs = [{ role: 'system', content: fullSystemPrompt }, ...(history || []).slice(-20), { role: 'user', content: userContent }]
      const reqBody = { model: agent.model || 'llama-3.3-70b-versatile', max_tokens: 1024, messages: msgs }
      if (tools) reqBody.tools = tools

      // Tool calling loop (max 3 rounds)
      let groqToolError = false
      for (let round = 0; round < 3; round++) {
        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentApiKey}` },
          body: JSON.stringify(reqBody),
        })
        const data = await res.json()
        if (data.error) {
          const errMsg = data.error.message || JSON.stringify(data.error)
          // If tool-related error, retry without tools instead of crashing
          if ((errMsg.includes('Failed to call a function') || errMsg.includes('tool')) && reqBody.tools) {
            console.log(`Groq tool error for ${agentId}, retrying without tools: ${errMsg}`)
            delete reqBody.tools
            groqToolError = true
            continue
          }
          throw new Error(errMsg)
        }

        const choice = data.choices?.[0]
        if (choice?.finish_reason === 'tool_calls' && choice.message?.tool_calls?.length) {
          // Agent wants to call tools
          reqBody.messages.push(choice.message)
          for (const tc of choice.message.tool_calls) {
            try {
              const args = JSON.parse(tc.function?.arguments || '{}')
              console.log(`Tool call [${agentId}]: ${tc.function.name} ${args.args}`)
              const result = await executeToolCall(tc.function.name, args.args || '', agentId)
              reqBody.messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: result.output || result.error || 'No output'
              })
            } catch(parseErr) {
              console.error(`Tool call parse error [${agentId}]:`, parseErr.message, 'raw:', tc.function?.arguments)
              reqBody.messages.push({
                role: 'tool',
                tool_call_id: tc.id,
                content: 'Error: Could not parse tool arguments. Try a simpler command.'
              })
            }
          }
          continue // Go to next round with tool results
        }

        // No tool calls — we have the final response
        responseText = choice?.message?.content || 'No response'
        break
      }
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

    // Clean up garbled function call syntax that Groq/Llama sometimes puts in text
    responseText = responseText
      .replace(/<\/?function[^>]*>/g, '')
      .replace(/\{\"args\":\"[^"]*\"\}/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim()

    if (!responseText || responseText === 'No response') {
      responseText = "I'm here but had trouble processing that. Can you rephrase?"
    }

    // ═══ BRAIN LEARNING — runs after every response ═══
    updateBrain(agentId, message, responseText)

    return { response: responseText }
  } catch (err) {
    console.error(`Agent ${agentId} error:`, err.message)
    // Clean up error messages for the user
    const msg = err.message || 'Something went wrong'
    if (msg.toLowerCase().includes('rate') || msg.toLowerCase().includes('limit') || msg.toLowerCase().includes('quota') || msg.toLowerCase().includes('too many')) return reply.code(429).send({ error: 'Taking a breather — too many messages. Try again in a minute.' })
    if (msg.includes('Failed to call a function') || msg.includes('tool_use_failed')) return reply.code(500).send({ error: 'I tried to use a tool but it failed. Let me try answering without tools — rephrase your question.' })
    return reply.code(500).send({ error: msg.length > 100 ? msg.slice(0, 100) + '...' : msg })
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
