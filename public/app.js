const noteField = document.querySelector("#note");
const statusEl = document.querySelector("#status");
const fontDecreaseButton = document.querySelector("#font-decrease");
const fontIncreaseButton = document.querySelector("#font-increase");

const AUTO_SEND_DELAY = 250;
const FONT_STORAGE_KEY = "notiz-benduhn:fontSize";
const FONT_MIN_PX = 14;
const FONT_MAX_PX = 28;
const FONT_STEP_PX = 2;

let sendTimer = null;
let lastServerContent = "";
let lastUpdatedAt = null;
let isConnected = false;
let hasPendingAck = false;
let lastSentContent = "";
let queuedContent = null;
let currentLock = null;
let lockTimer = null;
let lockCountdownInterval = null;
let wasLockedForUs = false;
let currentFontSizePx = null;

const socket = io();

const setStatus = (message, variant = "idle") => {
  statusEl.textContent = message;
  statusEl.dataset.variant = variant;
};

const normaliseErrorDetail = (error) => {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (typeof error.message === "string" && error.message.trim() !== "") {
    return error.message;
  }
  if (typeof error.description === "string" && error.description.trim() !== "") {
    return error.description;
  }
  if (typeof error.type === "string" && error.type.trim() !== "") {
    return error.type;
  }
  return "";
};

const interpretSocketError = (context, error) => {
  const detail = normaliseErrorDetail(error);
  const normalised = detail.toLowerCase();
  let advice;

  if (
    normalised.includes("xhr poll error") ||
    normalised.includes("transport close") ||
    normalised.includes("transport error")
  ) {
    advice =
      "Server nicht erreichbar – bitte prüfen, ob der Dienst läuft und die Seite ggf. neu laden.";
  } else if (normalised.includes("timeout")) {
    advice = "Zeitüberschreitung bei der Socket-Verbindung – Netzwerk oder Server prüfen.";
  } else if (normalised.includes("websocket")) {
    advice = "WebSocket-Verbindung fehlgeschlagen – eventuell blockiert ein Proxy oder eine Firewall.";
  } else {
    advice = "Netzwerkfehler bei der Socket-Verbindung.";
  }

  const detailSuffix = detail
    ? ` (Technisches Detail: ${detail})`
    : "";
  return `${context}: ${advice}${detailSuffix}`;
};

const describeDisconnectReason = (reason) => {
  if (!reason) return "unbekannter Grund";
  switch (reason) {
    case "io server disconnect":
      return "Server hat die Verbindung beendet";
    case "io client disconnect":
      return "durch Benutzeraktion getrennt";
    case "ping timeout":
      return "Zeitüberschreitung bei der Verbindung";
    case "transport close":
    case "transport error":
      return "Transportschicht wurde geschlossen";
    default:
      return reason;
  }
};

const formatTimestamp = (timestamp) => {
  if (!timestamp) return "eben synchronisiert";
  let date;
  if (typeof timestamp === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(timestamp)) {
    date = new Date(timestamp);
  } else if (typeof timestamp === "string" && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(timestamp)) {
    date = new Date(`${timestamp.replace(" ", "T")}Z`);
  } else {
    date = new Date(timestamp);
  }
  if (Number.isNaN(date.getTime())) return "unbekannt";
  return date.toLocaleString("de-DE");
};

const clampFontSize = (px) =>
  Math.max(FONT_MIN_PX, Math.min(FONT_MAX_PX, px));

const persistFontSize = (px) => {
  try {
    localStorage.setItem(FONT_STORAGE_KEY, String(px));
  } catch {
    // ignore storage failures
  }
};

const applyFontSize = (px, { persist = true } = {}) => {
  const clamped = clampFontSize(px);
  currentFontSizePx = clamped;
  noteField.style.fontSize = `${clamped}px`;
  if (persist) {
    persistFontSize(clamped);
  }
  updateFontButtons();
};

const updateFontButtons = () => {
  if (!fontDecreaseButton || !fontIncreaseButton) return;
  fontDecreaseButton.disabled = currentFontSizePx <= FONT_MIN_PX;
  fontIncreaseButton.disabled = currentFontSizePx >= FONT_MAX_PX;
};

const initialiseFontSize = () => {
  const computed = Number.parseFloat(
    window.getComputedStyle(noteField).fontSize
  );
  currentFontSizePx = Number.isFinite(computed) ? computed : 17;
  try {
    const stored = Number.parseFloat(localStorage.getItem(FONT_STORAGE_KEY));
    if (Number.isFinite(stored)) {
      applyFontSize(stored, { persist: false });
      return;
    }
  } catch {
    // ignore storage access issues
  }
  applyFontSize(currentFontSizePx, { persist: false });
};

const flushQueuedContent = () => {
  if (
    queuedContent === null ||
    !isConnected ||
    hasPendingAck ||
    isLockedForCurrentUser()
  ) {
    return;
  }
  if (queuedContent === lastServerContent) {
    queuedContent = null;
    return;
  }

  socket.emit("note:edit", { content: queuedContent });
  lastSentContent = queuedContent;
  hasPendingAck = true;
  queuedContent = null;
  setStatus("Übertrage Änderungen ...", "info");
};

const applyRemoteState = ({ content = "", updatedAt = null } = {}) => {
  const text = typeof content === "string" ? content : "";
  const localContent = noteField.value;
  const remoteMatchesLocal = localContent === text;
  const isAckOfPending = hasPendingAck && text === lastSentContent;
  const localAheadOfRemote =
    isAckOfPending && !remoteMatchesLocal && localContent !== lastSentContent;

  if (isAckOfPending) {
    hasPendingAck = false;
  }

  lastServerContent = text;
  lastUpdatedAt = updatedAt ?? null;

  if (localAheadOfRemote) {
    setStatus(
      `Server bestätigt frühere Änderungen: ${formatTimestamp(updatedAt)}`,
      "info"
    );
    flushQueuedContent();
    return;
  }

  if (!remoteMatchesLocal) {
    const prevLength = localContent.length;
    const selStart = noteField.selectionStart;
    const selEnd = noteField.selectionEnd;
    const cursorAtEnd = selStart === prevLength && selEnd === prevLength;

    noteField.value = text;
    if (cursorAtEnd) {
      const nextPos = noteField.value.length;
      noteField.selectionStart = nextPos;
      noteField.selectionEnd = nextPos;
    } else {
      noteField.selectionStart = selStart;
      noteField.selectionEnd = selEnd;
    }

    setStatus(
      `Live-Update empfangen: ${formatTimestamp(updatedAt)}`,
      "success"
    );
    flushQueuedContent();
    return;
  }

  setStatus(
    `Synchronisiert: ${formatTimestamp(updatedAt)}`,
    isConnected ? "success" : "info"
  );
  flushQueuedContent();
};

const sendUpdate = () => {
  clearTimeout(sendTimer);
  if (!isConnected) {
    setStatus("Keine Verbindung – Änderungen lokal", "error");
    return;
  }

  if (hasPendingAck) {
    queuedContent = noteField.value;
    setStatus("Warte auf Serverbestätigung ...", "info");
    return;
  }

  if (isLockedForCurrentUser()) {
    queuedContent = noteField.value;
    setStatus("Änderungen gesperrt – bitte kurz warten.", "info");
    return;
  }

  const content = noteField.value;
  if (content === lastServerContent) {
    setStatus(
      `Bereits synchron: ${formatTimestamp(lastUpdatedAt)}`,
      "info"
    );
    return;
  }

  socket.emit("note:edit", { content });
  lastSentContent = content;
  hasPendingAck = true;
  setStatus("Übertrage Änderungen ...", "info");
};

const scheduleSend = (immediate = false) => {
  clearTimeout(sendTimer);
  if (immediate) {
    sendUpdate();
  } else {
    sendTimer = setTimeout(sendUpdate, AUTO_SEND_DELAY);
  }
};

const integrateSharedContent = (payload) => {
  if (!payload || typeof payload !== "object") return;
  const { title = "", text = "", url = "" } = payload;
  const shareSegments = [title, text, url]
    .map((segment) => (typeof segment === "string" ? segment.trim() : ""))
    .filter((segment) => segment.length > 0);
  if (shareSegments.length === 0) return;
  const snippet = shareSegments.join("\n");
  const existing = noteField.value;
  const separator = existing.trim().length > 0 ? "\n\n" : "";
  noteField.value = `${existing}${separator}${snippet}`;
  setStatus("Geteilter Inhalt übernommen.", "success");
  noteField.focus();
  scheduleSend(true);
};

const handleServiceWorkerMessage = (event) => {
  if (!event || typeof event.data !== "object" || event.data === null) return;
  const { type, payload } = event.data;
  if (type !== "share-target") return;
  integrateSharedContent(payload);
};

socket.on("connect", () => {
  isConnected = true;
  setStatus("Verbunden – synchronisiere ...", "info");
  if (noteField.value !== lastServerContent) {
    scheduleSend(true);
  } else {
    socket.emit("note:fetch");
  }
  flushQueuedContent();
});

socket.io.on("reconnect", () => {
  isConnected = true;
  setStatus("Verbindung wiederhergestellt – synchronisiere ...", "info");
  socket.emit("note:fetch");
  flushQueuedContent();
});

socket.on("disconnect", (reason) => {
  isConnected = false;
  const readableReason = describeDisconnectReason(reason);
  setStatus(
    `Verbindung getrennt (${readableReason}). Änderungen werden lokal gehalten.`,
    "error"
  );
});

socket.io.on("reconnect_attempt", (attempt) => {
  const suffix = typeof attempt === "number" ? ` (Versuch ${attempt})` : "";
  setStatus(
    `Versuche, die Socket-Verbindung wiederherzustellen${suffix} ...`,
    "info"
  );
});

socket.io.on("error", (err) => {
  setStatus(
    interpretSocketError("Socket-Verbindung fehlgeschlagen", err),
    "error"
  );
});

socket.io.on("connect_error", (err) => {
  setStatus(
    interpretSocketError("Verbindungsaufbau fehlgeschlagen", err),
    "error"
  );
});

socket.io.on("reconnect_error", (err) => {
  setStatus(
    interpretSocketError("Wiederverbindung fehlgeschlagen", err),
    "error"
  );
});

socket.io.on("reconnect_failed", (err) => {
  setStatus(
    interpretSocketError("Wiederverbindung endgültig fehlgeschlagen", err),
    "error"
  );
});

socket.io.on("connect_timeout", () => {
  setStatus(
    "Zeitüberschreitung beim Verbindungsaufbau – bitte Netzwerk oder Server prüfen.",
    "error"
  );
});

socket.on("note:error", (message) => {
  setStatus(message ?? "Unbekannter Fehler beim Speichern.", "error");
  hasPendingAck = false;
  flushQueuedContent();
});

socket.on("note:state", (payload = {}) => {
  const incoming = typeof payload === "object" && payload !== null ? payload : {};
  applyRemoteState(incoming);
});

socket.on("note:lock", (payload = {}) => {
  const lock =
    typeof payload === "object" && payload !== null
      ? {
          holderId: payload.holderId ?? null,
          expiresAt:
            typeof payload.expiresAt === "number" ? payload.expiresAt : null,
          isSelf: Boolean(payload.isSelf)
        }
      : { holderId: null, expiresAt: null };
  applyLock(lock);
});

socket.on("note:unlock", () => {
  applyLock(null);
});

noteField.addEventListener("input", () => {
  scheduleSend(false);
});

noteField.addEventListener("beforeinput", (event) => {
  if (isLockedForCurrentUser()) {
    event.preventDefault();
    setStatus("Änderungen gesperrt – bitte kurz warten.", "info");
  }
});

if (fontDecreaseButton && fontIncreaseButton) {
  fontDecreaseButton.addEventListener("click", () => {
    applyFontSize(currentFontSizePx - FONT_STEP_PX);
  });
  fontIncreaseButton.addEventListener("click", () => {
    applyFontSize(currentFontSizePx + FONT_STEP_PX);
  });
  initialiseFontSize();
}

window.addEventListener("beforeunload", () => {
  if (noteField.value !== lastServerContent && isConnected) {
    socket.emit("note:edit", { content: noteField.value });
  }
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.addEventListener("message", handleServiceWorkerMessage);
  window.addEventListener("load", () => {
    navigator.serviceWorker
      .register("/service-worker.js")
      .catch((err) => console.error("Service Worker registration failed:", err));
  });
}

const isLockedForCurrentUser = () => {
  if (!currentLock || !currentLock.holderId) return false;
  if (currentLock.expiresAt && currentLock.expiresAt < Date.now()) return false;
  if (currentLock.isSelf) return false;
  return currentLock.holderId !== socket.id;
};

const setEditingEnabled = (enabled) => {
  noteField.readOnly = !enabled;
  noteField.classList.toggle("is-locked", !enabled);
  if (!enabled) {
    noteField.blur();
  }
};

const clearLockTimer = () => {
  if (lockTimer) {
    clearTimeout(lockTimer);
    lockTimer = null;
  }
  if (lockCountdownInterval) {
    clearInterval(lockCountdownInterval);
    lockCountdownInterval = null;
  }
};

const updateLockCountdownStatus = () => {
  if (!currentLock) return;
  const remainingMs = Math.max(0, currentLock.expiresAt - Date.now());
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  setStatus(
    `Bearbeitung durch anderen Nutzer gesperrt (${remainingSeconds}s)`,
    "info"
  );
};

const applyLock = (lock) => {
  clearLockTimer();
  currentLock = lock && lock.holderId ? lock : null;
  if (!currentLock) {
    const shouldNotify = wasLockedForUs;
    wasLockedForUs = false;
    setEditingEnabled(true);
    if (shouldNotify) {
      setStatus("Bearbeitung wieder möglich.", "success");
    }
    flushQueuedContent();
    return;
  }

  if (!currentLock.expiresAt) {
    currentLock.expiresAt = Date.now() + 10000;
  }

  if (currentLock.isSelf || currentLock.holderId === socket.id) {
    wasLockedForUs = false;
    setEditingEnabled(true);
    flushQueuedContent();
    return;
  }

  wasLockedForUs = true;
  setEditingEnabled(false);
  const remainingMs = Math.max(0, currentLock.expiresAt - Date.now());
  updateLockCountdownStatus();
  lockCountdownInterval = setInterval(() => {
    if (!currentLock) {
      clearInterval(lockCountdownInterval);
      lockCountdownInterval = null;
      return;
    }
    updateLockCountdownStatus();
  }, 1000);
  lockTimer = setTimeout(() => {
    lockTimer = null;
    if (lockCountdownInterval) {
      clearInterval(lockCountdownInterval);
      lockCountdownInterval = null;
    }
    if (!currentLock) return;
    setEditingEnabled(true);
    currentLock = null;
    setStatus("Bearbeitung wieder möglich.", "success");
    wasLockedForUs = false;
    flushQueuedContent();
  }, remainingMs);
};
