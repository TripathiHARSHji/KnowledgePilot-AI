import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './App.css'

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:8080'
const TOKEN_STORAGE_KEY = 'knowledgepilot.token'
const ACTIVE_SESSION_STORAGE_KEY = 'knowledgepilot.activeSessionId'

function buildSessionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `session-${Date.now()}`
}

async function revealTextGradually(text, setText) {
  const safeText = String(text || '')
  if (safeText.length < 80) {
    setText(safeText)
    return
  }

  const chunkSize = Math.ceil(safeText.length / 48)
  for (let index = chunkSize; index <= safeText.length; index += chunkSize) {
    setText(safeText.slice(0, index))
    await new Promise((resolve) => {
      window.setTimeout(resolve, 18)
    })
  }

  setText(safeText)
}

function App() {
  const [authMode, setAuthMode] = useState('login')
  const [token, setToken] = useState(localStorage.getItem(TOKEN_STORAGE_KEY) || '')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [authLoading, setAuthLoading] = useState(false)
  const [authError, setAuthError] = useState('')

  const [user, setUser] = useState(null)
  const [documents, setDocuments] = useState([])
  const [sessions, setSessions] = useState([])
  const [activeSessionId, setActiveSessionId] = useState(
    localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY) || ''
  )

  const [messagesBySession, setMessagesBySession] = useState({})
  const [sourcesBySession, setSourcesBySession] = useState({})
  const [question, setQuestion] = useState('')
  const [selectedDocumentId, setSelectedDocumentId] = useState('')
  const [queryLoading, setQueryLoading] = useState(false)

  const [uploadFile, setUploadFile] = useState(null)
  const [uploadLoading, setUploadLoading] = useState(false)
  const [uploadError, setUploadError] = useState('')

  const [busyDocumentIds, setBusyDocumentIds] = useState(new Set())
  const [pageError, setPageError] = useState('')
  const messageListRef = useRef(null)

  const activeMessages = useMemo(
    () => messagesBySession[activeSessionId] || [],
    [messagesBySession, activeSessionId]
  )
  const activeSources = useMemo(
    () => sourcesBySession[activeSessionId] || [],
    [sourcesBySession, activeSessionId]
  )
  const processingDocumentIds = useMemo(
    () => new Set(documents.filter((document) => document.status === 'processing').map((document) => document.id)),
    [documents]
  )

  const apiRequest = useCallback(async (path, options = {}) => {
    const headers = {
      ...(options.headers || {}),
    }

    if (!(options.body instanceof FormData)) {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json'
    }

    if (token) {
      headers.Authorization = `Bearer ${token}`
    }

    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers,
    })

    const text = await response.text()
    const payload = text ? JSON.parse(text) : null

    if (!response.ok) {
      const errorMessage = payload?.error || 'Request failed'
      throw new Error(errorMessage)
    }

    return payload
  }, [token])

  const loadUserProfile = useCallback(async () => {
    const result = await apiRequest('/me', { method: 'GET' })
    setUser(result.user)
  }, [apiRequest])

  const loadDocuments = useCallback(async () => {
    const result = await apiRequest('/documents', { method: 'GET' })
    setDocuments(Array.isArray(result.documents) ? result.documents : [])
  }, [apiRequest])

  const loadSessions = useCallback(async () => {
    const result = await apiRequest('/sessions', { method: 'GET' })
    const nextSessions = Array.isArray(result.sessions) ? result.sessions : []
    setSessions(nextSessions)

    if (nextSessions[0]?.id) {
      setActiveSessionId((current) => {
        if (current) {
          return current
        }

        localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, nextSessions[0].id)
        return nextSessions[0].id
      })
    }
  }, [apiRequest])

  const loadSessionMessages = useCallback(async (sessionId) => {
    if (!sessionId) {
      return
    }

    const result = await apiRequest(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
      method: 'GET',
    })
    const loadedMessages = (result.messages || []).map((message) => ({
      role: message.role,
      content: message.content,
      createdAt: message.createdAt,
    }))

    setMessagesBySession((current) => ({
      ...current,
      [sessionId]: loadedMessages,
    }))
  }, [apiRequest])

  useEffect(() => {
    let cancelled = false

    async function runBootstrap() {
      if (!token) {
        if (!cancelled) {
          setUser(null)
          setDocuments([])
          setSessions([])
        }
        return
      }

      if (!cancelled) {
        setPageError('')
      }

      try {
        await Promise.all([loadUserProfile(), loadDocuments(), loadSessions()])
      } catch (error) {
        if (cancelled) {
          return
        }

        setPageError(error.message)
        localStorage.removeItem(TOKEN_STORAGE_KEY)
        setToken('')
        setUser(null)
      }
    }

    runBootstrap()

    return () => {
      cancelled = true
    }
  }, [loadDocuments, loadSessions, loadUserProfile, token])

  useEffect(() => {
    if (!activeSessionId || !token) {
      return
    }

    localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, activeSessionId)
    if (messagesBySession[activeSessionId]) {
      return
    }

    let cancelled = false
    async function runLoadSessionMessages() {
      try {
        await loadSessionMessages(activeSessionId)
      } catch (error) {
        if (!cancelled) {
          setPageError(error.message)
        }
      }
    }

    runLoadSessionMessages()

    return () => {
      cancelled = true
    }
  }, [activeSessionId, loadSessionMessages, messagesBySession, token])

  useEffect(() => {
    if (!token || !processingDocumentIds.size) {
      return undefined
    }

    const intervalId = window.setInterval(() => {
      loadDocuments().catch(() => {})
    }, 2500)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [loadDocuments, processingDocumentIds, token])

  useEffect(() => {
    const listNode = messageListRef.current
    if (!listNode) {
      return
    }

    listNode.scrollTop = listNode.scrollHeight
  }, [activeMessages])

  async function handleAuthSubmit(event) {
    event.preventDefault()
    setAuthLoading(true)
    setAuthError('')

    try {
      const result = await fetch(`${API_BASE}/auth/${authMode}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email, password }),
      })

      const payload = await result.json()
      if (!result.ok) {
        throw new Error(payload?.error || 'Authentication failed')
      }

      const nextToken = payload.token
      localStorage.setItem(TOKEN_STORAGE_KEY, nextToken)
      setToken(nextToken)
      setPassword('')
    } catch (error) {
      setAuthError(error.message)
    } finally {
      setAuthLoading(false)
    }
  }

  function handleLogout() {
    localStorage.removeItem(TOKEN_STORAGE_KEY)
    localStorage.removeItem(ACTIVE_SESSION_STORAGE_KEY)
    setToken('')
    setUser(null)
    setSessions([])
    setDocuments([])
    setMessagesBySession({})
    setSourcesBySession({})
    setActiveSessionId('')
  }

  async function handleUpload(event) {
    event.preventDefault()
    if (!uploadFile) {
      setUploadError('Choose a PDF, DOCX, or TXT file first.')
      return
    }

    setUploadLoading(true)
    setUploadError('')
    try {
      const formData = new FormData()
      formData.append('file', uploadFile)
      await apiRequest('/documents/upload', {
        method: 'POST',
        body: formData,
      })
      setUploadFile(null)
      await loadDocuments()
    } catch (error) {
      setUploadError(error.message)
    } finally {
      setUploadLoading(false)
    }
  }

  async function handleDocumentAction(documentId, action) {
    setBusyDocumentIds((current) => new Set(current).add(documentId))
    setPageError('')
    try {
      if (action === 'delete') {
        await apiRequest(`/documents/${documentId}`, { method: 'DELETE' })
      }

      if (action === 'reindex') {
        await apiRequest(`/documents/${documentId}/reindex`, { method: 'POST' })
      }

      await loadDocuments()
    } catch (error) {
      setPageError(error.message)
    } finally {
      setBusyDocumentIds((current) => {
        const next = new Set(current)
        next.delete(documentId)
        return next
      })
    }
  }

  function createSessionLocally(sessionId) {
    setSessions((current) => {
      if (current.some((session) => session.id === sessionId)) {
        return current
      }

      return [
        {
          id: sessionId,
          preview: 'New conversation',
          updatedAt: new Date().toISOString(),
          turnCount: 0,
        },
        ...current,
      ]
    })
  }

  function startNewSession() {
    const nextSessionId = buildSessionId()
    createSessionLocally(nextSessionId)
    setMessagesBySession((current) => ({
      ...current,
      [nextSessionId]: [],
    }))
    setSourcesBySession((current) => ({
      ...current,
      [nextSessionId]: [],
    }))
    setActiveSessionId(nextSessionId)
  }

  async function deleteSession(sessionId) {
    try {
      await apiRequest(`/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
    } catch {
      // Session may already be expired in Redis.
    }

    setSessions((current) => current.filter((session) => session.id !== sessionId))
    setMessagesBySession((current) => {
      const next = { ...current }
      delete next[sessionId]
      return next
    })
    setSourcesBySession((current) => {
      const next = { ...current }
      delete next[sessionId]
      return next
    })

    if (sessionId === activeSessionId) {
      const fallback = sessions.find((session) => session.id !== sessionId)?.id || ''
      setActiveSessionId(fallback)
    }
  }

  async function handleAsk(event) {
    event.preventDefault()
    const cleanedQuestion = question.trim()

    if (!cleanedQuestion || queryLoading) {
      return
    }

    let sessionId = activeSessionId
    if (!sessionId) {
      sessionId = buildSessionId()
      setActiveSessionId(sessionId)
      createSessionLocally(sessionId)
    }

    const userMessage = {
      role: 'user',
      content: cleanedQuestion,
      createdAt: new Date().toISOString(),
    }

    setMessagesBySession((current) => ({
      ...current,
      [sessionId]: [...(current[sessionId] || []), userMessage],
    }))

    setQuestion('')
    setQueryLoading(true)
    setPageError('')

    try {
      const payload = {
        question: cleanedQuestion,
        topK: 4,
        sessionId,
      }

      if (selectedDocumentId) {
        payload.documentId = Number(selectedDocumentId)
      }

      const result = await apiRequest('/query', {
        method: 'POST',
        body: JSON.stringify(payload),
      })

      const resolvedSessionId = result.session?.id || sessionId

      let baseMessages = []
      setMessagesBySession((current) => {
        baseMessages = [...(current[resolvedSessionId] || [])]
        return {
          ...current,
          [resolvedSessionId]: [...baseMessages, { role: 'assistant', content: '' }],
        }
      })

      await revealTextGradually(result.answer, (streamText) => {
        setMessagesBySession((current) => {
          const currentMessages = [...(current[resolvedSessionId] || [])]
          if (!currentMessages.length) {
            return current
          }

          currentMessages[currentMessages.length - 1] = {
            role: 'assistant',
            content: streamText,
            createdAt: new Date().toISOString(),
          }

          return {
            ...current,
            [resolvedSessionId]: currentMessages,
          }
        })
      })

      setSourcesBySession((current) => ({
        ...current,
        [resolvedSessionId]: Array.isArray(result.sources) ? result.sources : [],
      }))

      setActiveSessionId(resolvedSessionId)
      await loadSessions()
    } catch (error) {
      setPageError(error.message)
    } finally {
      setQueryLoading(false)
    }
  }

  if (!token || !user) {
    return (
      <main className="auth-shell">
        <section className="auth-card">
          <p className="badge">KnowledgePilot AI</p>
          <h1>Phase 5 Workspace</h1>
          <p className="subtitle">Sign in to upload files and chat over your own document context.</p>
          <div className="mode-row">
            <button
              type="button"
              className={authMode === 'login' ? 'mode active' : 'mode'}
              onClick={() => setAuthMode('login')}
            >
              Login
            </button>
            <button
              type="button"
              className={authMode === 'signup' ? 'mode active' : 'mode'}
              onClick={() => setAuthMode('signup')}
            >
              Signup
            </button>
          </div>
          <form onSubmit={handleAuthSubmit} className="auth-form">
            <label>
              Email
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                required
              />
            </label>
            <label>
              Password
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="At least 8 characters"
                required
              />
            </label>
            <button type="submit" disabled={authLoading}>
              {authLoading ? 'Working...' : authMode === 'login' ? 'Enter workspace' : 'Create account'}
            </button>
          </form>
          {authError ? <p className="error">{authError}</p> : null}
          <p className="hint">
            For production, switch to httpOnly cookies. This demo stores the JWT in localStorage.
          </p>
        </section>
      </main>
    )
  }

  return (
    <main className="layout-shell">
      <header className="topbar">
        <div>
          <p className="badge">KnowledgePilot AI</p>
          <h1>KnowledgePilot AI</h1>
        </div>
        <div className="topbar-right">
          <p>{user.email}</p>
          <button type="button" onClick={handleLogout}>Sign out</button>
        </div>
      </header>

      {pageError ? <p className="error-banner">{pageError}</p> : null}

      <section className="dashboard-grid">
        <aside className="panel sessions-panel">
          <div className="panel-head">
            <h2>Sessions</h2>
            <button type="button" onClick={startNewSession}>New</button>
          </div>
          <div className="session-list">
            {sessions.length === 0 ? <p className="muted">No sessions yet.</p> : null}
            {sessions.map((session) => (
              <article
                key={session.id}
                className={activeSessionId === session.id ? 'session-item active' : 'session-item'}
                onClick={() => setActiveSessionId(session.id)}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    setActiveSessionId(session.id)
                  }
                }}
              >
                <div>
                  <p>{session.preview || 'Untitled session'}</p>
                  <small>{session.turnCount || 0} turns</small>
                </div>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation()
                    deleteSession(session.id)
                  }}
                >
                  x
                </button>
              </article>
            ))}
          </div>
        </aside>

        <section className="panel chat-panel">
          <div className="panel-head">
            <h2>Assistant</h2>
            <label className="document-filter">
              Scope
              <select
                value={selectedDocumentId}
                onChange={(event) => setSelectedDocumentId(event.target.value)}
              >
                <option value="">All documents</option>
                {documents.map((document) => (
                  <option key={document.id} value={document.id}>
                    {document.filename}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="message-list" ref={messageListRef}>
            {activeMessages.length === 0 ? (
              <p className="muted">Ask a question about your uploaded material.</p>
            ) : null}
            {activeMessages.map((message, index) => (
              <article key={`${message.role}-${index}`} className={`message ${message.role}`}>
                <p className="role">{message.role}</p>
                <div className="message-content markdown-body">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
                </div>
              </article>
            ))}
          </div>

          <form className="chat-form" onSubmit={handleAsk}>
            <textarea
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              rows={3}
              placeholder="Ask a grounded question about your documents..."
            />
            <button type="submit" disabled={queryLoading}>
              {queryLoading ? 'Thinking...' : 'Send'}
            </button>
          </form>
        </section>

        <aside className="panel docs-panel">
          <div className="panel-head">
            <h2>Documents</h2>
            <small>{documents.length} total</small>
          </div>

          <form className="upload-form" onSubmit={handleUpload}>
            <input
              type="file"
              accept=".pdf,.docx,.txt"
              onChange={(event) => setUploadFile(event.target.files?.[0] || null)}
            />
            <button type="submit" disabled={uploadLoading}>
              {uploadLoading ? 'Uploading...' : 'Upload'}
            </button>
          </form>
          {uploadError ? <p className="error">{uploadError}</p> : null}

          <div className="document-list">
            {documents.length === 0 ? <p className="muted">No files uploaded.</p> : null}
            {documents.map((document) => {
              const documentBusy = busyDocumentIds.has(document.id)
              const isProcessing = processingDocumentIds.has(document.id)
              return (
                <article key={document.id} className="document-item">
                  <div>
                    <p>{document.filename}</p>
                    <small className={isProcessing ? 'processing' : 'ready'}>{document.status}</small>
                  </div>
                  <div className="actions">
                    <button
                      type="button"
                      onClick={() => handleDocumentAction(document.id, 'reindex')}
                      disabled={documentBusy}
                    >
                      Re-index
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDocumentAction(document.id, 'delete')}
                      disabled={documentBusy}
                    >
                      Delete
                    </button>
                  </div>
                </article>
              )
            })}
          </div>
        </aside>
      </section>

      <section className="panel sources-panel">
        <div className="panel-head">
          <h2>Sources Used</h2>
        </div>
        {activeSources.length === 0 ? <p className="muted">No retrieved chunks yet.</p> : null}
        <div className="source-list">
          {activeSources.map((source, index) => (
            <article key={source.id || index} className="source-item">
              <p>
                {source.filename || source.metadata?.sourceFilename || `document-${source.documentId}`} | {' '}
                {(() => {
                  const pageStart = Number(source.metadata?.pageStart)
                  const pageEnd = Number(source.metadata?.pageEnd)
                  const hasPageStart = Number.isInteger(pageStart) && pageStart > 0
                  const hasPageEnd = Number.isInteger(pageEnd) && pageEnd > 0

                  if (!hasPageStart) {
                    const fallbackPosition = Number(source.metadata?.position)
                    if (Number.isInteger(fallbackPosition) && fallbackPosition > 0) {
                      return `p.${fallbackPosition}`
                    }

                    return 'p.n/a'
                  }

                  if (hasPageEnd && pageEnd !== pageStart) {
                    return `p.${pageStart}-${pageEnd}`
                  }

                  return `p.${pageStart}`
                })()} | similarity {Number(source.similarity || 0).toFixed(4)}
              </p>
              <pre>{source.content}</pre>
            </article>
          ))}
        </div>
      </section>
    </main>
  )
}

export default App
