const path = require('path')
const fs = require('fs')
const fastify = require('fastify')({ logger: true })
const cors = require('@fastify/cors')
const fastifyStatic = require('@fastify/static')
const { Server } = require('socket.io')

const { execSync } = require('child_process')

// Load .env
const envPath = path.join(__dirname, '..', '.env')
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, 'utf-8').split('\n').forEach(line => {
    const [key, ...val] = line.split('=')
    if (key && val.length) process.env[key.trim()] = val.join('=').trim()
  })
}

const CONFIG_PATH = path.join(__dirname, '..', 'kayou-config.json')

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
    // Bootstrap from example config on first run (e.g. Railway deploy)
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

fastify.register(cors, { origin: '*', methods: ['GET', 'POST', 'PUT', 'DELETE'] })
fastify.register(fastifyStatic, { root: path.join(__dirname, '..', 'out'), prefix: '/' })
fastify.register(fastifyStatic, { root: path.join(__dirname, '..', 'uploads'), prefix: '/uploads/', decorateReply: false })
fastify.get('/health', async () => ({ status: 'ok' }))

// ══════════════ AGENTS ══════════════
fastify.get('/api/config/agents', async () => {
  const c = loadConfig()
  return c.agents.map(a => ({ ...a, apiKey: a.apiKey ? '••••' + a.apiKey.slice(-4) : '', hasKey: !!a.apiKey }))
})
fastify.put('/api/config/agents/:id', async (req, reply) => {
  const c = loadConfig(); const idx = c.agents.findIndex(a => a.id === req.params.id)
  if (idx === -1) return reply.code(404).send({ error: 'Not found' })
  const u = req.body; const a = c.agents[idx]
  if (u.apiKey && !u.apiKey.startsWith('••••')) a.apiKey = u.apiKey
  ;['name','model','systemPrompt','enabled','provider','color','webhookUrl'].forEach(k => { if (u[k] !== undefined) a[k] = u[k] })
  if (u.permissions) a.permissions = u.permissions
  if (u.tasks) a.tasks = u.tasks
  if (u.profilePhoto !== undefined) a.profilePhoto = u.profilePhoto
  c.agents[idx] = a; saveConfig(c)
  return { ...a, apiKey: a.apiKey ? '••••' + a.apiKey.slice(-4) : '', hasKey: !!a.apiKey }
})
fastify.post('/api/config/agents', async (req) => {
  const c = loadConfig(); const { name, provider, apiKey, model, systemPrompt, color } = req.body
  const agent = { id: name.toLowerCase().replace(/[^a-z0-9]/g, '-'), name, provider: provider || 'anthropic', apiKey: apiKey || '', model: model || 'claude-sonnet-4-20250514', systemPrompt: systemPrompt || '', enabled: false, color: color || '#6366F1', permissions: ['projects','mcps'] }
  c.agents.push(agent); saveConfig(c)
  const key = resolveEnv(agent.apiKey); return { ...agent, apiKey: key ? '••••' + key.slice(-4) : '', hasKey: !!key }
})
fastify.delete('/api/config/agents/:id', async (req) => {
  const c = loadConfig(); c.agents = c.agents.filter(a => a.id !== req.params.id); saveConfig(c); return { ok: true }
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

// ══════════════ SERVICES (webhooks/external) ══════════════
fastify.get('/api/config/services', async () => loadConfig().services || [])
fastify.post('/api/config/services', async (req) => {
  const c = loadConfig(); if (!c.services) c.services = []
  const svc = { id: Date.now().toString(), ...req.body, createdAt: new Date().toISOString() }
  c.services.push(svc); saveConfig(c); return svc
})
fastify.delete('/api/config/services/:id', async (req) => {
  const c = loadConfig(); c.services = (c.services || []).filter(s => s.id !== req.params.id); saveConfig(c); return { ok: true }
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
  const { image, filename } = req.body // base64 image
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

  // Inject rules into system prompt
  const rules = c.rules || []
  const rulesText = rules.length > 0 ? '\n\nCOMPANY RULES (you must follow these):\n' + rules.map((r, i) => `${i + 1}. ${r}`).join('\n') : ''

  // Inject visible MCPs and projects context
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

  // Inject assigned tasks
  const tasks = agent.tasks || []
  let tasksText = ''
  if (tasks.length > 0) tasksText = '\n\nYOUR ASSIGNED TASKS:\n' + tasks.map((t, i) => `${i + 1}. ${t}`).join('\n')

  // Special ideas channel context
  const channelId = req.body.channelId || ''
  let channelContext = ''
  if (channelId === 'general') {
    channelContext = '\n\nYou\'re in #general — team room. Group chat with Aimar (CEO) and other agents. Messages show who said what as [Name]: format. Talk like you\'re texting coworkers. Keep it SHORT — 1-3 sentences unless you really need more. Don\'t repeat what someone already said.'
  } else if (channelId === 'ideas') {
    channelContext = '\n\nYou\'re in #ideas. Give your take from your expertise. Be specific and useful. Messages show who said what as [Name]: format. Keep it concise unless you\'re laying out a real plan.'
  } else if (channelId === 'build' || channelId === 'testing' || channelId === 'release' || channelId === 'research') {
    channelContext = `\n\nYou're in #${channelId}. This is a focused work channel. Group chat — messages show who said what as [Name]: format. Be concise and actionable. If you're the team lead, give your verdict after hearing from the team.`
  }

  const fullSystemPrompt = agent.systemPrompt + rulesText + contextText + tasksText + channelContext

  try {
    let responseText = ''
    if (agent.provider === 'anthropic') {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': agentApiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: agent.model || 'claude-sonnet-4-20250514', max_tokens: 500, system: fullSystemPrompt, messages: [...(history || []).slice(-10), { role: 'user', content: message }] }),
      })
      const data = await res.json()
      if (data.error) throw new Error(data.error.message)
      responseText = data.content?.[0]?.text || 'No response'
    } else if (agent.provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentApiKey}` },
        body: JSON.stringify({ model: agent.model || 'gpt-4o', max_tokens: 500, messages: [{ role: 'system', content: fullSystemPrompt }, ...(history || []).slice(-10), { role: 'user', content: message }] }),
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
        body: JSON.stringify({ model: agent.model || 'gemma3:4b', stream: false, messages: [{ role: 'system', content: fullSystemPrompt }, ...(history || []).slice(-10), userMsg] }),
      })
      const data = await res.json()
      responseText = data.message?.content || 'No response'
    } else if (agent.provider === 'groq') {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentApiKey}` },
        body: JSON.stringify({ model: agent.model || 'llama-3.3-70b-versatile', max_tokens: 500, messages: [{ role: 'system', content: fullSystemPrompt }, ...(history || []).slice(-10), { role: 'user', content: message }] }),
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
        body: JSON.stringify({ message, history: (history || []).slice(-10), systemPrompt: fullSystemPrompt, agentId, channelId }),
      })
      const data = await res.json()
      responseText = data.response || data.content || data.message || data.choices?.[0]?.message?.content || JSON.stringify(data)
    } else if (agent.provider === 'custom') {
      const res = await fetch(agent.model, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${agentApiKey}` }, body: JSON.stringify({ message, history }) })
      const data = await res.json()
      responseText = data.response || data.content || data.message || JSON.stringify(data)
    }
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
    io = new Server(fastify.server, { cors: { origin: '*', methods: ['GET', 'POST'] } })
    io.on('connection', (socket) => {
      console.log('Client connected:', socket.id)
      socket.on('disconnect', () => console.log('Client disconnected:', socket.id))
    })
    const c = loadConfig()
    console.log(`Server running on http://localhost:${port}`)
    console.log(`Agents: ${c.agents.length} | Projects: ${(c.projects||[]).length} | MCPs: ${(c.mcps||[]).length}`)
  } catch (err) { fastify.log.error(err); process.exit(1) }
}
start()
