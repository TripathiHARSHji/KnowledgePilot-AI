import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import './App.css'
import { GoogleLogin } from "@react-oauth/google";
// NEW: VITE_API_URL is baked in at build time. If it's not set, a
// production build now falls back to a relative, same-origin path
// (the Express server serves both the API and the built client) —
// previously it fell back to http://localhost:8080, which only ever
// worked on the machine that built it, never for real users.
const API_BASE = import.meta.env.VITE_API_URL || (import.meta.env.PROD ? '' : 'http://localhost:8080')
const TOKEN_STORAGE_KEY = 'knowledgepilot.token'
const ACTIVE_SESSION_STORAGE_KEY = 'knowledgepilot.activeSessionId'
const TOP_K_STORAGE_KEY = 'knowledgepilot.topK'
const THEME_STORAGE_KEY = 'knowledgepilot.theme'

// NEW: keep this in sync with MIN_TOP_K / MAX_TOP_K on the server
// (server/src/services/chat-history-service.js). If you change the
// env vars there, update these too so the UI slider matches.
const TOP_K_MIN = 1
const TOP_K_MAX = 20
const TOP_K_DEFAULT = 6

// NEW: default request timeout, and a longer one for /query since
// generation can legitimately take longer than a normal API call.
const DEFAULT_TIMEOUT_MS = 30000
const QUERY_TIMEOUT_MS = 90000

// NEW: strips the auto-appended "References:" block from an answer
// so the chat bubble stays clean — the same information is available
// per-message via the "Sources" dropdown instead of dumped as text.
const REFERENCES_BLOCK_PATTERN = /\n{1,2}References:\n(?:-.*(?:\n|$))+$/i

function stripReferencesBlock(text) {
  return String(text || '').replace(REFERENCES_BLOCK_PATTERN, '').trim()
}

function getInitials(name, email) {
  const source = (name || '').trim() || (email || '').trim()
  if (!source) {
    return '?'
  }

  const parts = source.split(/\s+/).filter(Boolean)
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase()
  }

  return source.slice(0, 2).toUpperCase()
}

function formatSourceLabel(source) {
  const filename = source.filename || source.metadata?.sourceFilename || `document-${source.documentId}`
  const pageStart = Number(source.metadata?.pageStart)
  const pageEnd = Number(source.metadata?.pageEnd)
  const hasPageStart = Number.isInteger(pageStart) && pageStart > 0
  const hasPageEnd = Number.isInteger(pageEnd) && pageEnd > 0

  let page = 'p.n/a'
  if (hasPageStart) {
    page = hasPageEnd && pageEnd !== pageStart ? `p.${pageStart}-${pageEnd}` : `p.${pageStart}`
  } else {
    const fallbackPosition = Number(source.metadata?.position)
    if (Number.isInteger(fallbackPosition) && fallbackPosition > 0) {
      page = `p.${fallbackPosition}`
    }
  }

  return { filename, page }
}

function buildSessionId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `session-${Date.now()}`
}

function App() {
  const [authMode, setAuthMode] = useState('login')
  const [token, setToken] = useState(localStorage.getItem(TOKEN_STORAGE_KEY) || '')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  // NEW: name is required at signup, matching the backend rule.
  const [name, setName] = useState('')
  const [authLoading, setAuthLoading] = useState(false)
  const [authError, setAuthError] = useState('')

  const [user, setUser] = useState(null)
  const [documents, setDocuments] = useState([])
  const [sessions, setSessions] = useState([])
  const [activeSessionId, setActiveSessionId] = useState(
    localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY) || ''
  )

  const [messagesBySession, setMessagesBySession] = useState({})
  const [question, setQuestion] = useState('')
  const [selectedDocumentId, setSelectedDocumentId] = useState('')
  const [queryLoading, setQueryLoading] = useState(false)

  // NEW: which message's "Sources" dropdown is expanded, keyed by
  // `${sessionId}:${messageIndex}`.
  const [openSourceKeys, setOpenSourceKeys] = useState(() => new Set())

  // NEW: dark mode, persisted across visits.
  const [theme, setTheme] = useState(() => localStorage.getItem(THEME_STORAGE_KEY) || 'light')
  const [accountMenuOpen, setAccountMenuOpen] = useState(false)
  const accountMenuRef = useRef(null)

  // NEW: topK is now a user-controlled setting instead of a hardcoded 4.
  const [topK, setTopK] = useState(() => {
    const stored = Number(localStorage.getItem(TOP_K_STORAGE_KEY))
    return Number.isInteger(stored) && stored >= TOP_K_MIN && stored <= TOP_K_MAX
      ? stored
      : TOP_K_DEFAULT
  })

  const [uploadFile, setUploadFile] = useState(null)
  const [uploadLoading, setUploadLoading] = useState(false)
  const [uploadError, setUploadError] = useState('')

  const [busyDocumentIds, setBusyDocumentIds] = useState(new Set())
  const [pageError, setPageError] = useState('')
  const messageListRef = useRef(null)
  const textareaRef = useRef(null)

  const activeMessages = useMemo(
    () => messagesBySession[activeSessionId] || [],
    [messagesBySession, activeSessionId]
  )
  const processingDocumentIds = useMemo(
    () => new Set(documents.filter((document) => document.status === 'processing').map((document) => document.id)),
    [documents]
  )

  useEffect(() => {
    localStorage.setItem(TOP_K_STORAGE_KEY, String(topK))
  }, [topK])

  // NEW: apply the theme to the document root so CSS variables can
  // switch, and persist the choice.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme)
    localStorage.setItem(THEME_STORAGE_KEY, theme)
  }, [theme])

  // NEW: close the account dropdown on outside click.
  useEffect(() => {
    if (!accountMenuOpen) {
      return undefined
    }

    function handleClickOutside(event) {
      if (accountMenuRef.current && !accountMenuRef.current.contains(event.target)) {
        setAccountMenuOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [accountMenuOpen])

  function toggleTheme() {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'))
  }

  function toggleSourcesFor(key) {
    setOpenSourceKeys((current) => {
      const next = new Set(current)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  // NEW: apiRequest now supports a timeoutMs option and surfaces a
  // clear "timed out" error instead of hanging forever if the server
  // or an upstream call (e.g. Gemini) never responds.
  const apiRequest = useCallback(async (path, options = {}) => {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, ...fetchOptions } = options

    const headers = {
      ...(fetchOptions.headers || {}),
    }

    if (!(fetchOptions.body instanceof FormData)) {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json'
    }

    if (token) {
      headers.Authorization = `Bearer ${token}`
    }

    const controller = new AbortController()
    const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(`${API_BASE}${path}`, {
        ...fetchOptions,
        headers,
        signal: controller.signal,
      })

      const text = await response.text()
      const payload = text ? JSON.parse(text) : null

      if (!response.ok) {
        const errorMessage = payload?.error || 'Request failed'
        throw new Error(errorMessage)
      }

      return payload
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error('Request timed out. The server took too long to respond — please try again.')
      }
      throw error
    } finally {
      window.clearTimeout(timeoutId)
    }
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
      sources: [],
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
      loadDocuments().catch(() => { })
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
      const body = authMode === 'signup'
        ? { email, password, name }
        : { email, password }

      const result = await fetch(`${API_BASE}/auth/${authMode}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
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
    setActiveSessionId('')
    setAccountMenuOpen(false)
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
        // NEW: topK comes from the slider/select below instead of a
        // hardcoded 4, so you can ask for more chunks on a big doc.
        topK,
        sessionId,
      }

      if (selectedDocumentId) {
        payload.documentId = Number(selectedDocumentId)
      }

      // NEW: give /query a longer timeout since generation can
      // legitimately take a while, but it will still fail with a
      // clear error instead of spinning forever.
      const result = await apiRequest('/query', {
        method: 'POST',
        body: JSON.stringify(payload),
        timeoutMs: QUERY_TIMEOUT_MS,
      })

      const resolvedSessionId = result.session?.id || sessionId
      const sources = Array.isArray(result.sources) ? result.sources : []

      setMessagesBySession((current) => {
        const currentMessages = [...(current[resolvedSessionId] || [])]

        currentMessages.push({
          role: 'assistant',
          content: result.answer,
          // NEW: sources travel with the message itself so each
          // answer gets its own "Sources" dropdown instead of one
          // shared panel that only ever reflects the last query.
          sources,
        })

        return {
          ...current,
          [resolvedSessionId]: currentMessages,
        }
      })

      setActiveSessionId(resolvedSessionId)
      await loadSessions()
    } catch (error) {
      setPageError(error.message)
    } finally {
      setQueryLoading(false)
    }
  }

  // NEW: Enter sends the message, Shift+Enter inserts a newline —
  // no more reaching for the mouse/Send button every time.
  function handleQuestionKeyDown(event) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      handleAsk(event)
    }
  }

  async function handleGoogleSuccess(credentialResponse) {
    setAuthLoading(true)
    setAuthError('')

    try {
      const result = await fetch(`${API_BASE}/auth/google`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          credential: credentialResponse.credential,
        }),
      })

      const payload = await result.json()

      if (!result.ok) {
        throw new Error(payload?.error || 'Google authentication failed')
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

  const themeToggle = (
    <button
      type="button"
      className="theme-toggle"
      onClick={toggleTheme}
      aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
    >
      <span className={`theme-toggle-track ${theme === 'dark' ? 'is-dark' : ''}`}>
        <span className="theme-toggle-thumb">{theme === 'dark' ? '🌙' : '☀️'}</span>
      </span>
    </button>
  )

  if (!token || !user) {
    return (
      <main className="auth-shell">
        {themeToggle}
        <section className="auth-card">
          <p className="badge">*beta</p>
          <h1>KnowledgePilot AI</h1>
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
            {authMode === 'signup' ? (
              <label>
                Name
                <input
                  type="text"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Ada Lovelace"
                  required
                  maxLength={120}
                />
              </label>
            ) : null}
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
            <div className="divider"><span>or</span></div>
            <div className="google-btn-wrap">
              <GoogleLogin onSuccess={handleGoogleSuccess} onError={() => setAuthError('Google Login Failed')} />
            </div>
          </form>
          {authError ? <p className="error">{authError}</p> : null}
          <p className="hint">
            @HarshTripathi
          </p>
        </section>
      </main>
    )
  }

  return (
    <main className="layout-shell">
      <header className="topbar">
        <div>
          <p className="badge">*beta</p>
          <h1>KnowledgePilot AI</h1>
        </div>
        <div className="topbar-right">
          {themeToggle}
          <div className="account-menu" ref={accountMenuRef}>
            <button
              type="button"
              className="account-trigger"
              onClick={() => setAccountMenuOpen((current) => !current)}
            >
              {user.avatarUrl ? (
                <img className="avatar avatar-img" src={user.avatarUrl} alt="" referrerPolicy="no-referrer" />
              ) : (
                <span className="avatar avatar-initials">{getInitials(user.name, user.email)}</span>
              )}
              <span className="account-trigger-text">
                <span className="account-name">{user.name || user.email}</span>
                <span className="account-email">{user.email}</span>
              </span>
              <span className={`chevron ${accountMenuOpen ? 'open' : ''}`}>▾</span>
            </button>

            {accountMenuOpen ? (
              <div className="account-dropdown">
                <div className="account-dropdown-header">
                  {user.avatarUrl ? (
                    <img className="avatar avatar-img avatar-lg" src={user.avatarUrl} alt="" referrerPolicy="no-referrer" />
                  ) : (
                    <span className="avatar avatar-initials avatar-lg">{getInitials(user.name, user.email)}</span>
                  )}
                  <div>
                    <p className="account-dropdown-name">{user.name || 'Unnamed'}</p>
                    <p className="account-dropdown-email">{user.email}</p>
                    <span className="account-provider-badge">
                      {user.avatarUrl ? 'Google account' : 'Email account'}
                    </span>
                  </div>
                </div>
                <button type="button" className="account-dropdown-signout" onClick={handleLogout}>
                  Sign out
                </button>
              </div>
            ) : null}
          </div>
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
                  ×
                </button>
              </article>
            ))}
          </div>
        </aside>

        <section className="panel chat-panel">
          <div className="panel-head">
            <h2>Assistant</h2>
            <div className="chat-controls">
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
              {/* NEW: topK control — 4 for a short/simple doc, up to 20
                  for something like a novel that needs more chunks
                  retrieved to answer well. */}
              <label className="topk-filter" title="How many document chunks to retrieve per question">
                Chunks (topK): {topK}
                <input
                  type="range"
                  min={TOP_K_MIN}
                  max={TOP_K_MAX}
                  step={1}
                  value={topK}
                  onChange={(event) => setTopK(Number(event.target.value))}
                />
              </label>
            </div>
          </div>

          <div className="message-list" ref={messageListRef}>
            {activeMessages.length === 0 ? (
              <p className="muted">Ask a question about your uploaded material.</p>
            ) : null}
            {activeMessages.map((message, index) => {
              const sourceKey = `${activeSessionId}:${index}`
              const hasSources = Array.isArray(message.sources) && message.sources.length > 0
              const isSourcesOpen = openSourceKeys.has(sourceKey)
              const displayContent = message.role === 'assistant'
                ? stripReferencesBlock(message.content)
                : message.content

              return (
                <article key={`${message.role}-${index}`} className={`message ${message.role}`}>
                  <p className="role">{message.role}</p>
                  <div className="message-content markdown-body">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{displayContent}</ReactMarkdown>
                  </div>
                  {hasSources ? (
                    <div className="source-dropdown">
                      <button
                        type="button"
                        className="source-toggle"
                        onClick={() => toggleSourcesFor(sourceKey)}
                      >
                        {isSourcesOpen ? 'Hide' : 'Show'} sources ({message.sources.length})
                        <span className={`chevron ${isSourcesOpen ? 'open' : ''}`}>▾</span>
                      </button>
                      {isSourcesOpen ? (
                        <div className="source-dropdown-panel">
                          {message.sources.map((source, sourceIndex) => {
                            const { filename, page } = formatSourceLabel(source)
                            return (
                              <article key={source.id || sourceIndex} className="source-item">
                                <p>
                                  {filename} · {page} · similarity {Number(source.similarity || 0).toFixed(3)}
                                </p>
                                <pre>{source.content}</pre>
                              </article>
                            )
                          })}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              )
            })}
          </div>

          <form className="chat-form" onSubmit={handleAsk}>
            <textarea
              ref={textareaRef}
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              onKeyDown={handleQuestionKeyDown}
              rows={3}
              placeholder="Ask a grounded question about your documents... (Enter to send, Shift+Enter for a new line)"
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
    </main>
  )
}

export default App