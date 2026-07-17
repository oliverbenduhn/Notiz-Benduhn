import { Editor, Extension } from 'https://esm.sh/@tiptap/core@2'
import StarterKit from 'https://esm.sh/@tiptap/starter-kit@2'
import ImageExtension from 'https://esm.sh/@tiptap/extension-image@2'
import Placeholder from 'https://esm.sh/@tiptap/extension-placeholder@2'
import Suggestion from 'https://esm.sh/@tiptap/suggestion@2'

// Editor-Hülle: Tiptap-Instanz, eine geteilte Notiz, REST-Sync (PUT/GET /api/note).
// Bilder als NodeView (siehe createImageNodeView), Slash-Menu via Suggestion-Plugin.
// Modal-Bestätigungen via natives <dialog> (siehe confirmDialog).

// DOM-Refs
const editorEl   = document.querySelector('#editor')
const saveStatus = document.querySelector('#save-status')
const lastSaved  = document.querySelector('#last-saved')
const btnClear   = document.querySelector('#btn-clear')
const imageInput = document.querySelector('#image-input')
const toolbar    = document.querySelector('#toolbar')

// Status-Anzeige -- 5s Auto-Clear reicht screenreadern, sich anzuhören
// (Audit N6). "saved"-Variante bleibt sichtbar, bis sie überschrieben wird.
let saveTimer = null
function showStatus(text, variant) {
  saveStatus.textContent = text
  saveStatus.className = 'save-status ' + (variant ?? '')
  clearTimeout(saveTimer)
  if (variant === 'saved') {
    saveTimer = setTimeout(() => {
      saveStatus.textContent = ''
      saveStatus.className = 'save-status'
    }, 5000)
  }
}

function updateLastSaved() {
  lastSaved.textContent = 'gespeichert: gerade eben'
  setTimeout(() => { lastSaved.textContent = '' }, 5000)
}

// Bestätigungsdialog via natives <dialog>.
// autofocus auf "Abbrechen" -- die sichere Wahl (Audit M14).
// textContent statt innerHTML für die Message, damit kein XSS-Vektor
// hereinschleicht, falls später variabler Text eingesetzt wird (Audit M15).
function confirmDialog(message) {
  return new Promise(resolve => {
    const dlg = document.createElement('dialog')
    dlg.className = 'confirm-dialog'
    const form = document.createElement('form')
    form.method = 'dialog'
    const p = document.createElement('p')
    p.textContent = message
    const menu = document.createElement('menu')
    const cancel = document.createElement('button')
    cancel.type = 'submit'
    cancel.value = 'cancel'
    cancel.dataset.action = 'cancel'
    cancel.textContent = 'Abbrechen'
    cancel.autofocus = true
    const ok = document.createElement('button')
    ok.type = 'submit'
    ok.value = 'ok'
    ok.dataset.action = 'ok'
    ok.className = 'danger'
    ok.textContent = 'OK'
    menu.append(cancel, ok)
    form.append(p, menu)
    dlg.append(form)
    dlg.addEventListener('close', () => {
      resolve(dlg.returnValue === 'ok')
      dlg.remove()
    })
    document.body.appendChild(dlg)
    dlg.showModal()
  })
}

// API -- liefert/akzeptiert jetzt updatedAt, damit der Client Remote-Änderungen
// erkennen kann (Audit K3).
async function loadNote() {
  const res = await fetch('/api/note')
  if (!res.ok) throw new Error('Laden fehlgeschlagen')
  const { content, updatedAt } = await res.json()
  return { content, updatedAt }
}

async function saveNote(content) {
  const res = await fetch('/api/note', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content })
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.error || 'Speichern fehlgeschlagen')
  }
  const { updatedAt } = await res.json()
  return updatedAt
}

// Bild-Upload -- zählt laufende Uploads, damit Multi-Image-Drop einen
// sinnvollen Status zeigt statt "Speichern..." (Audit H9).
let uploadsInFlight = 0
async function uploadImage(file) {
  uploadsInFlight++
  showStatus(`Lädt hoch... (${uploadsInFlight})`, 'saving')
  try {
    const form = new FormData()
    form.append('image', file, file.name)
    const res = await fetch('/api/images', { method: 'POST', body: form })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || 'Upload fehlgeschlagen')
    }
    const { url } = await res.json()
    return url
  } finally {
    uploadsInFlight--
    if (uploadsInFlight === 0) showStatus('Gespeichert.', 'saved')
  }
}

async function deleteImageFile(src) {
  const parts = src.split('/uploads/')
  if (parts.length < 2) return
  const filename = parts[1]
  await fetch('/api/images/' + encodeURIComponent(filename), { method: 'DELETE' })
}

// Bild-Vollbild-Overlay (mit Esc + role=dialog + Tastatur-Fokus, Audit M4)
function openImageOverlay(src) {
  const overlay = document.createElement('div')
  overlay.className = 'image-overlay'
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-label', 'Bild Vollbild')
  overlay.tabIndex = -1
  const big = document.createElement('img')
  big.src = src
  big.alt = ''
  overlay.appendChild(big)
  const close = () => overlay.remove()
  overlay.addEventListener('click', close)
  overlay.addEventListener('keydown', e => { if (e.key === 'Escape') close() })
  document.body.appendChild(overlay)
  overlay.focus()
}

async function insertImageFromFile(file) {
  try {
    const url = await uploadImage(file)
    editor.chain()
      .focus()
      .insertContent({ type: 'image', attrs: { src: url, alt: '', title: null } })
      .run()
  } catch (err) {
    console.error(err)
    showStatus('Upload fehlgeschlagen.', 'error')
  }
}

// DOM-Kinder entfernen
function clearChildren(el) {
  while (el.firstChild) el.removeChild(el.firstChild)
}

// Klick aufs Bild öffnet das Vollbild-Overlay. stopPropagation verhindert,
// dass ProseMirror die Auswahl auf den Node setzt (würde Selection-Ring zeigen).
function onImageClick(src, event) {
  event.stopPropagation()
  event.preventDefault()
  openImageOverlay(src)
}

// Bild löschen: erst Node aus dem Doc, dann Datei vom Server. Wenn der
// Doc-Delete scheitert, lassen wir die Datei liegen -- sonst zeigt der Doc
// ins Leere (Audit M13).
async function onImageDelete({ src, editor, getPos, nodeSize }) {
  if (!await confirmDialog('Bild loeschen?')) return
  const pos = typeof getPos === 'function' ? getPos() : null
  if (typeof pos !== 'number') return
  const removed = editor.chain().focus().deleteRange({ from: pos, to: pos + nodeSize }).run()
  if (!removed) {
    showStatus('Löschen fehlgeschlagen.', 'error')
    return
  }
  deleteImageFile(src).catch(() => {})
}

// Tiptap-NodeView für Bilder -- SANCTIONED-PATTERN.
// ProseMirror kontrolliert den Wrapper; externe DOM-Mutation (z. B. nachträgliches
// insertBefore + appendChild) löst eine onUpdate → wrapImages → onUpdate-Schleife aus.
// Position für Delete via getPos() -- die node-Referenz wird nach der nächsten Transaktion stale.
function createImageNodeView(props, ed) {
  const { node, getPos } = props
  const wrapper = document.createElement('div')
  wrapper.className = 'image-wrapper'

  const img = document.createElement('img')
  img.src = node.attrs.src
  img.alt = node.attrs.alt ?? ''
  img.addEventListener('click', e => onImageClick(img.src, e))
  wrapper.appendChild(img)

  const del = document.createElement('button')
  del.className = 'image-delete-btn'
  del.type = 'button'
  del.textContent = '\u00d7'
  del.title = 'Bild loeschen'
  del.setAttribute('aria-label', 'Bild loeschen')
  del.addEventListener('click', () => onImageDelete({
    src: img.src,
    editor: ed,
    getPos,
    nodeSize: node.nodeSize,
  }))
  wrapper.appendChild(del)

  return { dom: wrapper }
}

// Auto-Save -- tracked pendingContent, damit pagehide den letzten Stand
// noch wegschicken kann (Audit H7).
let autoSaveTimer = null
let pendingContent = null
let lastSavedContent = null  // JSON-String des zuletzt gespeicherten Stands

async function flushPending() {
  if (!pendingContent) return
  try {
    const updatedAt = await saveNote(pendingContent)
    knownUpdatedAt = updatedAt
    lastSavedContent = JSON.stringify(pendingContent)
    pendingContent = null
    showStatus('Gespeichert.', 'saved')
    updateLastSaved()
  } catch {
    showStatus('Speichern fehlgeschlagen.', 'error')
  }
}

function scheduleAutoSave() {
  if (loadFailed) return
  pendingContent = editor.getJSON()
  clearTimeout(autoSaveTimer)
  showStatus('Speichern...', 'saving')
  autoSaveTimer = setTimeout(flushPending, 800)
}

// Slash-Menue -- benutzt toggle* statt setNode, damit der zweite /h1
// den H1 wieder entfernt (Audit M11).
const SLASH_COMMANDS = [
  { title: 'Ueberschrift 1', kw: ['h1','ueberschrift 1','ueberschrift','heading 1','heading1'],
    icon: 'H1',
    cmd: (ed, range) => ed.chain().focus().deleteRange(range).toggleHeading({ level: 1 }).run() },
  { title: 'Ueberschrift 2', kw: ['h2','ueberschrift 2','heading 2','heading2'],
    icon: 'H2',
    cmd: (ed, range) => ed.chain().focus().deleteRange(range).toggleHeading({ level: 2 }).run() },
  { title: 'Aufzaehlung', kw: ['ul','bullet','liste','list','aufzaehlung','aufzählung'],
    icon: '=',
    cmd: (ed, range) => ed.chain().focus().deleteRange(range).toggleBulletList().run() },
  { title: 'Nummerierte Liste', kw: ['ol','nummeriert','numbered','ordered'],
    icon: '1.',
    cmd: (ed, range) => ed.chain().focus().deleteRange(range).toggleOrderedList().run() },
  { title: 'Code-Block', kw: ['code','pre','block','codeblock','code-block'],
    icon: '<>',
    cmd: (ed, range) => ed.chain().focus().deleteRange(range).toggleCodeBlock().run() },
  { title: 'Bild hochladen', kw: ['image','bild','foto','photo','img','pic'],
    icon: '[+]',
    cmd: (ed, range) => { ed.chain().focus().deleteRange(range).run(); imageInput.click() } },
]

// Slash-Filter: matcht Titel + Alias-Array (kw).
function matchCommand(c, q) {
  if (!q) return true
  const ql = q.toLowerCase()
  return c.title.toLowerCase().includes(ql) || c.kw.some(k => k.includes(ql))
}

function buildSlashItem(item, isFocused, props) {
  const el = document.createElement('div')
  el.className = 'slash-item' + (isFocused ? ' focused' : '')
  const iconEl = document.createElement('span')
  iconEl.className = 'slash-icon'
  iconEl.textContent = item.icon
  const labelEl = document.createElement('span')
  labelEl.textContent = item.title
  el.appendChild(iconEl)
  el.appendChild(labelEl)
  el.addEventListener('mousedown', e => {
    e.preventDefault()
    item.cmd(props.editor, props.range)
  })
  return el
}

function renderSlashMenu(popup, items, selectedIndex, props) {
  clearChildren(popup)
  if (!items || items.length === 0) { popup.style.display = 'none'; return }
  popup.style.display = ''
  items.forEach((item, i) => popup.appendChild(buildSlashItem(item, i === selectedIndex, props)))
}

function positionSlashMenu(popup, rect) {
  if (!rect) return
  popup.style.top  = (rect.bottom + 6) + 'px'
  popup.style.left = Math.min(rect.left, window.innerWidth - 220) + 'px'
}

const SlashMenu = Extension.create({
  name: 'slashMenu',
  addProseMirrorPlugins() {
    return [Suggestion({
      editor: this.editor,
      char: '/',
      startOfLine: false,
      items: ({ query }) => SLASH_COMMANDS.filter(c => matchCommand(c, query)),
      render: () => {
        let popup = null
        let selected = 0
        let editorRef = null
        let outsideHandler = null
        return {
          onStart(props) {
            selected = 0
            editorRef = props.editor
            popup = document.createElement('div')
            popup.className = 'slash-menu'
            document.body.appendChild(popup)
            renderSlashMenu(popup, props.items, selected, props)
            positionSlashMenu(popup, props.clientRect?.())
            outsideHandler = e => {
              if (popup && !popup.contains(e.target) && !editorEl.contains(e.target)) {
                editorRef.chain().focus().run()
              }
            }
            document.addEventListener('mousedown', outsideHandler)
          },
          onUpdate(props) {
            selected = 0
            renderSlashMenu(popup, props.items, selected, props)
            positionSlashMenu(popup, props.clientRect?.())
          },
          onKeyDown(props) {
            // Suggestion liefert in onKeyDown nur {editor, event, range}.
            // query/items aus dem range ableiten (Audit AGENTS §Tiptap-gotchas).
            const ed = props.editor ?? editor
            const text = ed.state.doc.textBetween(props.range.from, props.range.to, '\n') ?? ''
            const query = text.startsWith('/') ? text.slice(1) : text
            const items = SLASH_COMMANDS.filter(c => matchCommand(c, query))
            if (items.length === 0) return false
            if (props.event.key === 'ArrowDown') {
              selected = (selected + 1) % items.length
              renderSlashMenu(popup, props.items, selected, props)
              return true
            }
            if (props.event.key === 'ArrowUp') {
              selected = (selected - 1 + items.length) % items.length
              renderSlashMenu(popup, props.items, selected, props)
              return true
            }
            if (props.event.key === 'Enter') {
              // Modul-Closure statt props.editor: bleibt konsistent mit
              // mousedown-Pfad und matcht der etablierten Editor-Referenz
              // (Audit M12).
              items[selected]?.cmd(ed, props.range)
              return true
            }
            if (props.event.key === 'Escape') {
              ed.chain().focus().run()
              return true
            }
            return false
          },
          onExit() {
            if (outsideHandler) document.removeEventListener('mousedown', outsideHandler)
            popup?.remove(); popup = null
          }
        }
      },
      command: ({ editor: ed, range, props }) => props.cmd(ed, range)
    })]
  }
})

// Editor
const editor = new Editor({
  element: editorEl,
  extensions: [
    StarterKit,
    ImageExtension.configure({ inline: false, allowBase64: false })
      .extend({ addNodeView() { return (props) => createImageNodeView(props, editor) } }),
    Placeholder.configure({ placeholder: 'Text eingeben oder / fuer Befehle ...' }),
    SlashMenu,
  ],
  editorProps: {
    handleDrop(_view, event, _slice, moved) {
      if (moved) return false
      const files = Array.from(event.dataTransfer?.files ?? [])
        .filter(f => f.type.startsWith('image/'))
      if (files.length === 0) return false
      event.preventDefault()
      files.forEach(f => insertImageFromFile(f))
      document.body.classList.remove('drag-over')
      return true
    },
    handlePaste(_view, event) {
      const files = Array.from(event.clipboardData?.files ?? [])
        .filter(f => f.type.startsWith('image/'))
      if (files.length === 0) return false
      event.preventDefault()
      files.forEach(f => insertImageFromFile(f))
      return true
    }
  },
  onUpdate() { scheduleAutoSave() }
})

// Toolbar -- setzt aria-pressed für Screenreader-Toggle-State (Audit N5).
toolbar.addEventListener('click', e => {
  const btn = e.target.closest('[data-action]')
  if (!btn) return
  const chain = editor.chain().focus()
  switch (btn.dataset.action) {
    case 'h1':      chain.toggleHeading({ level: 1 }).run(); break
    case 'h2':      chain.toggleHeading({ level: 2 }).run(); break
    case 'bold':    chain.toggleBold().run(); break
    case 'italic':  chain.toggleItalic().run(); break
    case 'bullet':  chain.toggleBulletList().run(); break
    case 'ordered': chain.toggleOrderedList().run(); break
    case 'code':    chain.toggleCodeBlock().run(); break
    case 'image':   imageInput.click(); break
  }
})

function updateToolbarState() {
  toolbar.querySelectorAll('[data-action]').forEach(btn => {
    let active = false
    switch (btn.dataset.action) {
      case 'h1':      active = editor.isActive('heading', { level: 1 }); break
      case 'h2':      active = editor.isActive('heading', { level: 2 }); break
      case 'bold':    active = editor.isActive('bold'); break
      case 'italic':  active = editor.isActive('italic'); break
      case 'bullet':  active = editor.isActive('bulletList'); break
      case 'ordered': active = editor.isActive('orderedList'); break
      case 'code':    active = editor.isActive('codeBlock'); break
    }
    btn.classList.toggle('active', active)
    btn.setAttribute('aria-pressed', String(active))
  })
}
editor.on('selectionUpdate', updateToolbarState)
editor.on('transaction',     updateToolbarState)

// Bild via Datei-Input
imageInput.addEventListener('change', () => {
  Array.from(imageInput.files ?? []).forEach(f => insertImageFromFile(f))
  imageInput.value = ''
})

// Drag-Over-Indikator -- Counter-Ansatz statt relatedTarget-Filter,
// kein Flackern mehr beim Drag über Child-Elemente (Audit M2).
let dragCounter = 0
document.addEventListener('dragenter', e => {
  const hasImage = Array.from(e.dataTransfer?.items ?? [])
    .some(i => i.kind === 'file' && i.type.startsWith('image/'))
  if (!hasImage) return
  dragCounter++
  e.preventDefault()
  document.body.classList.add('drag-over')
})
document.addEventListener('dragleave', () => {
  dragCounter--
  if (dragCounter <= 0) {
    dragCounter = 0
    document.body.classList.remove('drag-over')
  }
})
document.addEventListener('dragover', e => {
  if (dragCounter > 0) e.preventDefault()
})
document.addEventListener('drop', () => {
  dragCounter = 0
  document.body.classList.remove('drag-over')
})

// Leeren
btnClear.addEventListener('click', async () => {
  if (!await confirmDialog('Notiz leeren?')) return
  editor.commands.clearContent(true)
  scheduleAutoSave()
})

// Service-Worker registrieren -- ohne ihn ist Cache, Offline und Share-Target
// inaktiv (Audit K1).
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/service-worker.js').catch(err => {
    console.error('Service-Worker-Registrierung fehlgeschlagen:', err)
  })

  // Share-Target: Texte + Bilder aus Android-Share landen direkt im Editor
  // (Audit K2).
  navigator.serviceWorker.addEventListener('message', e => {
    if (e.data?.type !== 'share-target') return
    const { title, text, url, imageUrls } = e.data.payload || {}
    const textParts = [title, text, url].filter(Boolean)
    if (textParts.length > 0) {
      editor.chain().focus().insertContent(textParts.join('\n\n')).run()
    }
    for (const imgUrl of imageUrls || []) {
      editor.chain()
        .focus()
        .insertContent({ type: 'image', attrs: { src: imgUrl, alt: '', title: null } })
        .run()
    }
  })
}

// pagehide -- letzten Stand synchron wegschicken, damit der 800ms-Debounce
// nicht zum Datenverlust wird (Audit H7). keepalive erlaubt dem Browser,
// den Tab sofort zu schließen.
window.addEventListener('pagehide', () => {
  if (!pendingContent) return
  try {
    fetch('/api/note', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: pendingContent }),
      keepalive: true
    })
  } catch (err) {
    console.error('pagehide flush fehlgeschlagen:', err)
  }
})

// Polling: prüft alle 5s auf Remote-Änderungen. Bei Versatz mit ungespeicherten
// lokalen Edits nur Hinweis, sonst stiller Reload (Audit K3).
let knownUpdatedAt = null
let loadFailed = false

async function pollForChanges() {
  try {
    const { content, updatedAt } = await loadNote()
    if (!updatedAt || updatedAt === knownUpdatedAt) return
    const currentJson = JSON.stringify(editor.getJSON())
    if (currentJson === lastSavedContent) {
      editor.commands.setContent(content, false)
      knownUpdatedAt = updatedAt
      lastSavedContent = currentJson
    } else {
      showStatus('Andere Person hat geändert — Reload zum Übernehmen.', 'error')
    }
  } catch (err) {
    // Netz weg / Server tot -- still ignorieren, nächster Tick versucht erneut.
  }
}

// Initialer Load mit Failure-Guard: bei Fehler wird Auto-Save deaktiviert,
// damit der User nicht den Remote-Stand überschreibt (Audit H6).
;(async () => {
  try {
    const { content, updatedAt } = await loadNote()
    knownUpdatedAt = updatedAt
    if (content && Object.keys(content).length > 0) {
      editor.commands.setContent(content, false)
    }
    lastSavedContent = JSON.stringify(editor.getJSON())
    editor.commands.focus('end')
    setInterval(pollForChanges, 5000)
  } catch (err) {
    console.error('Laden fehlgeschlagen:', err)
    loadFailed = true
    showStatus('Laden fehlgeschlagen — Auto-Save deaktiviert.', 'error')
  }
})()