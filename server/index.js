const path = require('path')
const fastify = require('fastify')({ logger: true })
const cors = require('@fastify/cors')
const fastifyStatic = require('@fastify/static')
const { Server } = require('socket.io')

// Setup CORS
fastify.register(cors, {
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE']
})

// Serve Next.js static export
fastify.register(fastifyStatic, {
  root: path.join(__dirname, '..', 'out'),
  prefix: '/',
})

// Health check
fastify.get('/health', async () => {
  return { status: 'ok', timestamp: new Date().toISOString() }
})

// Mock data - replace with PostgreSQL queries
let messages = []
let users = [
  { id: '1', username: 'Kayou Code', online: true },
  { id: '2', username: 'Aimar', online: true },
  { id: '3', username: 'Berenice', online: false },
  { id: '4', username: 'Elite ICT', online: true },
]

// API Routes
fastify.get('/api/users', async (request, reply) => {
  return users
})

fastify.get('/api/messages/:userId/:otherId', async (request, reply) => {
  const { userId, otherId } = request.params
  const filtered = messages.filter(
    m => (m.senderId === userId && m.receiverId === otherId) ||
         (m.senderId === otherId && m.receiverId === userId)
  )
  return filtered.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
})

fastify.post('/api/messages', async (request, reply) => {
  const { content, senderId, receiverId } = request.body
  const message = {
    id: Date.now().toString(),
    content,
    senderId,
    receiverId,
    createdAt: new Date().toISOString()
  }
  messages.push(message)
  return message
})

// Create HTTP server
const start = async () => {
  try {
    const port = process.env.PORT || 3001
    await fastify.listen({ port: Number(port), host: '0.0.0.0' })

    // Setup Socket.io
    const io = new Server(fastify.server, {
      cors: {
        origin: '*',
        methods: ['GET', 'POST']
      }
    })

    io.on('connection', (socket) => {
      console.log('Client connected:', socket.id)

      socket.on('join', (userId) => {
        socket.userId = userId
        console.log(`User ${userId} joined`)

        // Broadcast user online
        users = users.map(u =>
          u.id === userId ? { ...u, online: true } : u
        )
        io.emit('users:update', users)
      })

      socket.on('message', (data) => {
        const message = {
          id: Date.now().toString(),
          content: data.content,
          senderId: data.senderId,
          receiverId: data.receiverId,
          createdAt: new Date().toISOString()
        }
        messages.push(message)

        // Emit to both sender and receiver
        io.emit('message:new', message)
      })

      socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id)
        if (socket.userId) {
          // Broadcast user offline
          users = users.map(u =>
            u.id === socket.userId ? { ...u, online: false } : u
          )
          io.emit('users:update', users)
        }
      })
    })

    console.log(`Server running on http://localhost:${port}`)
  } catch (err) {
    fastify.log.error(err)
    process.exit(1)
  }
}

start()
