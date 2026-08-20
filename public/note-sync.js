// Note synchronization owns the state transitions that otherwise leak into editor event handlers.
export function createNoteSynchronization({
  readContent,
  applyContent,
  showStatus,
  updateLastSaved,
  setEditingAvailable,
  onConflict,
}) {
  let autoSaveTimer = null
  let pendingContent = null
  let lastSavedContent = null
  let knownRevision = null
  let loadFailed = false
  let saveInFlight = false
  let inFlightContent = null

  const snapshot = () => JSON.stringify(readContent())

  async function loadNote(sinceRevision) {
    const suffix = Number.isInteger(sinceRevision) ? `?since=${sinceRevision}` : ''
    const res = await fetch('/api/note' + suffix)
    if (res.status === 204) return null
    if (!res.ok) throw new Error('Laden fehlgeschlagen')
    return res.json()
  }

  async function saveNote(content) {
    const res = await fetch('/api/note', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, revision: knownRevision })
    })
    if (res.status === 409) {
      const conflict = await res.json()
      const error = new Error(conflict.error)
      error.conflict = conflict
      throw error
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || 'Speichern fehlgeschlagen')
    }
    return res.json()
  }

  async function flushPending() {
    if (!pendingContent || saveInFlight) return
    const content = pendingContent
    saveInFlight = true
    inFlightContent = content
    try {
      const { revision } = await saveNote(content)
      knownRevision = revision
      lastSavedContent = JSON.stringify(content)
      if (pendingContent === content) {
        pendingContent = null
        showStatus('Gespeichert.', 'saved')
        updateLastSaved()
      }
    } catch (err) {
      if (err.conflict) onConflict(err.conflict.content, err.conflict.revision)
      else if (pendingContent === content) showStatus('Speichern fehlgeschlagen.', 'error')
    } finally {
      saveInFlight = false
      inFlightContent = null
      if (pendingContent && pendingContent !== content) flushPending()
    }
  }

  function schedule() {
    if (loadFailed) return
    pendingContent = readContent()
    clearTimeout(autoSaveTimer)
    showStatus('Speichern...', 'saving')
    autoSaveTimer = setTimeout(flushPending, 800)
  }

  function acceptRemote(content, revision) {
    applyContent(content)
    pendingContent = null
    knownRevision = revision
    lastSavedContent = snapshot()
    showStatus('Remote-Version übernommen.', 'saved')
  }

  function markCleared(revision) {
    pendingContent = null
    knownRevision = revision
    lastSavedContent = snapshot()
  }

  function keepLocal(revision) {
    knownRevision = revision
    flushPending()
  }

  function flushOnPageHide() {
    if (!pendingContent || (saveInFlight && pendingContent === inFlightContent)) return
    // The lifecycle ends here, so a newer snapshot gets one best-effort
    // keepalive attempt even while an older save is still resolving.
    try {
      fetch('/api/note', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: pendingContent, revision: knownRevision }),
        keepalive: true
      })
    } catch (err) {
      console.error('pagehide flush fehlgeschlagen:', err)
    }
  }

  async function pollForChanges() {
    try {
      const note = await loadNote(knownRevision)
      if (!note) return
      const { content, revision } = note
      if (snapshot() === lastSavedContent) {
        applyContent(content)
        knownRevision = revision
        lastSavedContent = snapshot()
      } else {
        onConflict(content, revision)
      }
    } catch {
      // Network failures are retried by the next poll without blocking editing.
    }
  }

  async function start() {
    try {
      const { content, revision } = await loadNote()
      knownRevision = revision
      if (content && Object.keys(content).length > 0) applyContent(content)
      lastSavedContent = snapshot()
      setInterval(pollForChanges, 5000)
      return true
    } catch (err) {
      console.error('Laden fehlgeschlagen:', err)
      loadFailed = true
      setEditingAvailable(false)
      showStatus('Laden fehlgeschlagen — Auto-Save deaktiviert.', 'error')
      return false
    }
  }

  return {
    acceptRemote,
    flushPending,
    flushOnPageHide,
    getRevision: () => knownRevision,
    isAvailable: () => !loadFailed,
    keepLocal,
    markCleared,
    schedule,
    start,
  }
}
