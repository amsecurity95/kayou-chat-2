const path = require('path')
const fs = require('fs')
const fastify = require('fastify')({ logger: true })
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
    if (fs.existsSync(CONFIG_PATH)) return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'))
    const examplePath = path.join(__dirname, '..', 'kayou-config.example.json')
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
  return learnings.slice(0, 3) // Max 3 learnings per response
}

// Feed mentor's response into student's brain
function mentorLearn(studentId, mentorResponse, topic) {
  const brain = loadBrain(studentId)
  const learnings = extractLearnings(mentorResponse, topic)
  for (const l of learnings) {
    if (!brain.mentorLearnings.includes(l)) {
      brain.mentorLearnings.push(l)
      // Keep last 50 mentor learnings
      if (brain.mentorLearnings.length > 50) brain.mentorLearnings.shift()
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
    if (!brain.knowledge.includes(l) && brain.knowledge.length < 100) {
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

// ══════════════ AGENTS ══════════════
fastify.get('/api/config/agents', async () => {
  const c = loadConfig()
  return c.agents.map(a => {
    const brain = loadBrain(a.id)
    return { ...a, apiKey: a.apiKey ? '••••' + a.apiKey.slice(-4) : '', hasKey: !!a.apiKey, brain: { interactions: brain.interactions, lastActive: brain.lastActive, personalityCount: brain.personality.length, knowledgeCount: brain.knowledge.length, mentorLearnings: brain.mentorLearnings.length, mentor: brain.mentor } }
  })
})
fastify.put('/api/config/agents/:id', async (req, reply) => {
  const c = loadConfig(); const idx = c.agents.findIndex(a => a.id === req.params.id)
  if (idx === -1) return reply.code(404).send({ error: 'Not found' })
  const u = req.body; const a = c.agents[idx]
  if (u.apiKey && !u.apiKey.startsWith('••••')) a.apiKey = u.apiKey
  ;['name','model','systemPrompt','enabled','provider','color','webhookUrl','mentor'].forEach(k => { if (u[k] !== undefined) a[k] = u[k] })
  if (u.permissions) a.permissions = u.permissions
  if (u.tasks) a.tasks = u.tasks
  if (u.profilePhoto !== undefined) a.profilePhoto = u.profilePhoto
  c.agents[idx] = a; saveConfig(c)
  return { ...a, apiKey: a.apiKey ? '••••' + a.apiKey.slice(-4) : '', hasKey: !!a.apiKey }
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

// ══════════════ FILESYSTEM (My Apps access) ══════════════
const MY_APPS_DIR = path.join(require('os').homedir(), 'Desktop', 'My Apps')

fastify.get('/api/files/list', async (req) => {
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

// ══════════════ MESSAGES (persistent) ══════════════
fastify.get('/api/messages/:channel', async (req) => {
  if (!db) return []
  const { rows } = await db.query(
    'SELECT * FROM messages WHERE channel = $1 ORDER BY created_at ASC LIMIT 200',
    [req.params.channel]
  )
  return rows.map(r => ({
    id: r.id, sender: r.sender_id, name: r.sender_name, text: r.text,
    color: r.color, photo: r.photo, ts: r.created_at
  }))
})

fastify.post('/api/messages', async (req) => {
  if (!db) return { ok: false, reason: 'no database' }
  const { channel, senderId, senderName, text, color, photo } = req.body
  const { rows } = await db.query(
    'INSERT INTO messages (channel, sender_id, sender_name, text, color, photo) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at',
    [channel, senderId, senderName, text, color || null, photo || null]
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
  const { agentId, message, history, imageBase64 } = req.body
  const c = loadConfig()
  const agent = c.agents.find(a => a.id === agentId)
  if (!agent) return reply.code(404).send({ error: 'Agent not found' })
  if (!agent.enabled) return reply.code(400).send({ error: 'Agent is disabled' })
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
  if (channelId === 'general') {
    channelContext = '\n\nYou\'re in #general — team room. Group chat with Aimar (CEO) and other agents. Messages show who said what as [Name]: format. Talk like you\'re texting coworkers. Keep it SHORT — 1-3 sentences unless you really need more. Don\'t repeat what someone already said.'
  } else if (channelId === 'ideas') {
    channelContext = '\n\nYou\'re in #ideas. Give your take from your expertise. Be specific and useful. Messages show who said what as [Name]: format. Keep it concise unless you\'re laying out a real plan.'
  } else if (channelId === 'build' || channelId === 'testing' || channelId === 'release' || channelId === 'research') {
    channelContext = `\n\nYou're in #${channelId}. This is a focused work channel. Group chat — messages show who said what as [Name]: format. Be concise and actionable. If you're the team lead, give your verdict after hearing from the team.`
  }

  // Filesystem context for Kayou Code
  let filesystemContext = ''
  if (perms.includes('filesystem') || agentId === 'kayou-code') {
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
    if (agent.provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': agentApiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: agent.model || 'claude-sonnet-4-20250514', max_tokens: 500, system: fullSystemPrompt, messages: [...(history || []).slice(-20), { role: 'user', content: message }] }),
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
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentApiKey}` },
        body: JSON.stringify({ model: agent.model || 'llama-3.3-70b-versatile', max_tokens: 500, messages: [{ role: 'system', content: fullSystemPrompt }, ...(history || []).slice(-20), { role: 'user', content: message }] }),
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
    const c = loadConfig()
    console.log(`Server running on http://localhost:${port}`)
    console.log(`Agents: ${c.agents.length} | Projects: ${(c.projects||[]).length} | Brains: ${fs.readdirSync(BRAINS_DIR).length} | DB: ${db ? 'connected' : 'none'}`)
  } catch (err) { fastify.log.error(err); process.exit(1) }
}
start()
