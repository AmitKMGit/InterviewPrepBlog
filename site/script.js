(() => {
  "use strict";

  const STORAGE_KEY = "margin.notebook.v2";
  const NOTEBOOK_V1_KEY = "margin.notebook.v1";
  const LEGACY_KEY = "margin.entries.v1";
  const shell = document.querySelector("#app-shell");
  const sidebar = document.querySelector("#sidebar");
  const addButton = document.querySelector("#add-button");
  const searchInput = document.querySelector("#search-input");
  const noteList = document.querySelector("#note-list");
  const listEmpty = document.querySelector("#list-empty");
  const titleField = document.querySelector("#note-title");
  const contentField = document.querySelector("#note-content");
  const fontFamily = document.querySelector("#font-family");
  const fontSize = document.querySelector("#font-size");
  const boldButton = document.querySelector("#bold-button");
  const italicButton = document.querySelector("#italic-button");
  const codeButton = document.querySelector("#code-button");
  const decreaseSizeButton = document.querySelector("#decrease-size");
  const increaseSizeButton = document.querySelector("#increase-size");
  const menuButton = document.querySelector("#menu-button");
  const drawerScrim = document.querySelector("#drawer-scrim");
  const toast = document.querySelector("#toast");
  const syncApi = (window.NOTEBOOK_SYNC_API || "").replace(/\/+$/, "");
  const SYNC_DELAY_MS = 60_000;
  const syncPanel = document.querySelector("#sync-panel");
  const syncStatus = document.querySelector("#sync-status");
  const syncButton = document.querySelector("#sync-button");
  const SESSION_KEY = "margin.notebook.session.v1";

  let notes = loadNotes();
  let selectedId = null;
  let toastTimer;
  let savedRange = null;
  let syncToken = sessionStorage.getItem(SESSION_KEY) || "";
  let syncTimer;
  let syncReady = false;
  let lastSyncedFingerprint = null;
  let canEdit = !syncApi;

  function loadNotes() {
    try {
      const current = localStorage.getItem(STORAGE_KEY);
      const notebookV1 = current ? null : localStorage.getItem(NOTEBOOK_V1_KEY);
      const legacy = current || notebookV1 ? null : localStorage.getItem(LEGACY_KEY);
      const stored = current || notebookV1 || legacy;
      if (!stored) return [];
      const parsed = JSON.parse(stored);
      if (!Array.isArray(parsed) || parsed.some((note) =>
        !note || typeof note.id !== "string" || typeof note.title !== "string" || typeof note.content !== "string"
      )) throw new Error("Saved notes have an invalid format.");

      const loaded = parsed.map((note) => ({
        id: note.id,
        title: note.title,
        content: current ? sanitizeRichText(note.content)
          : legacy ? sanitizeRichText(note.content)
            : textToHtml(note.content),
        updatedAt: typeof note.updatedAt === "string" ? note.updatedAt : ""
      }));
      if (!current) localStorage.setItem(STORAGE_KEY, JSON.stringify(loaded));
      return loaded;
    } catch (error) {
      console.error("Could not load notebook notes.", error);
      window.setTimeout(() => showToast("Couldn't read saved notes. Your browser storage may be unavailable."), 0);
      return [];
    }
  }

    function setCanEdit(enabled) {
      canEdit = enabled;
      addButton.disabled = !enabled;
      shell.classList.toggle("sync-locked", !enabled);
      if (selectedId) {
        titleField.contentEditable = String(enabled);
        contentField.contentEditable = String(enabled);
        titleField.setAttribute("aria-readonly", String(!enabled));
        contentField.setAttribute("aria-readonly", String(!enabled));
      }
      setFormattingEnabled(Boolean(selectedId && enabled));
      renderList();
    }

    function normalizeNote(note) {
      return {
        id: note.id,
        title: note.title,
        content: sanitizeRichText(note.content),
        updatedAt: typeof note.updatedAt === "string" ? note.updatedAt : ""
      };
    }

    function mergeNotes(remoteNotes, localNotes) {
      const merged = new Map(remoteNotes.map((note) => [note.id, normalizeNote(note)]));
      const order = remoteNotes.map((note) => note.id);
      for (const localNote of localNotes) {
        const local = normalizeNote(localNote);
        const remote = merged.get(local.id);
        const localTime = Date.parse(local.updatedAt) || 0;
        const remoteTime = remote ? Date.parse(remote.updatedAt) || 0 : -1;
        if (!remote) order.unshift(local.id);
        if (!remote || localTime >= remoteTime) merged.set(local.id, local);
      }
      return order.map((id) => merged.get(id)).filter(Boolean);
    }

    async function requestSync(path, options = {}) {
      const response = await fetch(`${syncApi}${path}`, {
        ...options,
        headers: {
          ...(options.headers || {}),
          ...(syncToken ? { Authorization: `Bearer ${syncToken}` } : {})
        }
      });
      let result;
      try {
        result = await response.json();
      } catch {
        throw new Error("The sync service returned an invalid response.");
      }
      if (!response.ok) {
        if (response.status === 401) {
          syncToken = "";
          sessionStorage.removeItem(SESSION_KEY);
          syncReady = false;
          window.clearTimeout(syncTimer);
          setCanEdit(false);
          syncButton.textContent = "Connect GitHub";
          syncStatus.textContent = "Session expired. Connect again to edit.";
        }
        throw new Error(result.error || `Sync failed (${response.status}).`);
      }
      return result;
    }

    function setSyncStatus(message) {
      if (syncStatus) syncStatus.textContent = message;
    }

    function scheduleSync() {
      const fingerprint = notesFingerprint();
      if (fingerprint === lastSyncedFingerprint) {
        window.clearTimeout(syncTimer);
        setSyncStatus("Connected · no pending changes");
        return;
      }

      window.clearTimeout(syncTimer);
      setSyncStatus("Saved here · sync in 1 minute if unchanged");
      syncTimer = window.setTimeout(async () => {
        const latestFingerprint = notesFingerprint();
        if (latestFingerprint === lastSyncedFingerprint) return;

        try {
          await requestSync("/api/notes", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ notes })
          });
          lastSyncedFingerprint = latestFingerprint;
          setSyncStatus("Queued · publishing on the next minute schedule");
        } catch (error) {
          console.error("Could not queue notebook sync.", error);
          setSyncStatus("Sync failed · your browser copy is saved");
          showToast(error.message);
        }
      }, SYNC_DELAY_MS);
    }

    function notesFingerprint() {
      return JSON.stringify(notes.map(({ id, title, content }) => ({ id, title, content })));
    }

    function chooseNoteAfterSync() {
      if (notes.length) selectNote(notes.some((note) => note.id === selectedId) ? selectedId : notes[0].id);
      else {
        selectedId = null;
        titleField.contentEditable = "false";
        contentField.contentEditable = "false";
        titleField.setAttribute("aria-readonly", "true");
        contentField.setAttribute("aria-readonly", "true");
        titleField.textContent = "";
        contentField.innerHTML = "";
        setFormattingEnabled(false);
        renderList();
      }
    }

    async function loadPublishedNotes() {
      if (notes.length) return;
      try {
        const response = await fetch("./notes.json", { cache: "no-store" });
        if (!response.ok) throw new Error(`Published notes could not be loaded (${response.status}).`);
        const published = await response.json();
        if (!Array.isArray(published)) throw new Error("Published notes have an invalid format.");
        notes = published.map(normalizeNote);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
      } catch (error) {
        console.error("Could not load published notebook notes.", error);
        setSyncStatus("Could not load published notes");
        showToast(error.message);
      }
    }

    async function initializeSync() {
      syncPanel.hidden = false;
      syncButton.addEventListener("click", () => {
        if (syncToken) {
          syncToken = "";
          syncReady = false;
          window.clearTimeout(syncTimer);
          sessionStorage.removeItem(SESSION_KEY);
          setCanEdit(false);
          syncButton.textContent = "Connect GitHub";
          setSyncStatus("Disconnected · read-only");
          return;
        }
        window.location.href = `${syncApi}/api/auth/login`;
      });

      const fragment = new URLSearchParams(window.location.hash.slice(1));
      const returnedToken = fragment.get("session");
      if (returnedToken && /^[a-f0-9]{64}$/.test(returnedToken)) {
        syncToken = returnedToken;
        sessionStorage.setItem(SESSION_KEY, returnedToken);
        history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      }

      const syncError = new URLSearchParams(window.location.search).get("sync");
      if (syncError) {
        const messages = {
          failed: "GitHub sign-in failed. Please try again.",
          "wrong-account": "Connect using the configured GitHub account."
        };
        showToast(messages[syncError] || "GitHub sign-in failed.");
        history.replaceState(null, "", window.location.pathname);
      }

      if (!syncToken) {
        syncButton.textContent = "Connect GitHub";
        setCanEdit(false);
        setSyncStatus("Read-only · connect to edit and sync");
        await loadPublishedNotes();
        chooseNoteAfterSync();
        return;
      }

      syncButton.textContent = "Disconnect";
      setSyncStatus("Connecting…");
      setCanEdit(true);
      try {
        const remote = await requestSync("/api/notes");
        if (!Array.isArray(remote.notes)) throw new Error("GitHub returned an invalid notes list.");
        const remoteNotes = remote.notes.map(normalizeNote);
        const merged = mergeNotes(remoteNotes, notes);
        const remoteFingerprint = JSON.stringify(remoteNotes.map(({ id, title, content }) => ({ id, title, content })));
        const differs = JSON.stringify(merged.map(({ id, title, content }) => ({ id, title, content }))) !== remoteFingerprint;
        notes = merged;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
        lastSyncedFingerprint = remoteFingerprint;
        syncReady = true;
        chooseNoteAfterSync();
        setSyncStatus(remote.pending ? "Queued · publishing on the next minute schedule" : "Connected · no pending changes");
        if (differs) scheduleSync();
      } catch (error) {
        console.error("Could not initialize notebook sync.", error);
        setSyncStatus("Sync unavailable · browser copy is saved");
        showToast(error.message);
      }
    }

  function sanitizeRichText(html) {
    const parsed = new DOMParser().parseFromString(html, "text/html");
    const allowed = new Set(["B", "STRONG", "I", "EM", "U", "OL", "UL", "LI", "PRE", "CODE", "P", "BR", "BLOCKQUOTE", "FONT"]);
    const safeFaces = new Set(["Georgia", "Arial", "Courier New", "cursive"]);

    function copySafeNodes(source, target) {
      for (const node of source.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
          target.append(document.createTextNode(node.textContent));
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          if (allowed.has(node.tagName)) {
            const safeElement = document.createElement(node.tagName.toLowerCase());
            if (node.tagName === "FONT") {
              const face = node.getAttribute("face");
              const size = node.getAttribute("size");
              if (safeFaces.has(face)) safeElement.setAttribute("face", face);
              if (/^[2-7]$/.test(size || "")) safeElement.setAttribute("size", size);
            }
            copySafeNodes(node, safeElement);
            target.append(safeElement);
          } else if (!["SCRIPT", "STYLE", "IFRAME", "OBJECT", "SVG", "MATH"].includes(node.tagName)) {
            copySafeNodes(node, target);
          }
        }
      }
    }

    const safe = document.createElement("div");
    copySafeNodes(parsed.body, safe);
    return safe.innerHTML;
  }

  function textToHtml(text) {
    const escaped = document.createElement("div");
    escaped.textContent = text;
    return escaped.innerHTML.replace(/\r?\n/g, "<br>");
  }

  function saveNotes() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(notes));
      if (syncToken && syncReady) scheduleSync();
      return true;
    } catch (error) {
      console.error("Could not save notebook notes.", error);
      showToast("Couldn't save this note. Browser storage may be full or disabled.");
      return false;
    }
  }

  function noteText(field) {
    return (field.innerText || field.textContent || "").replace(/\r/g, "");
  }

  function renderList() {
    const query = searchInput.value.trim().toLocaleLowerCase();
    const visibleNotes = notes.filter((note) => note.title.toLocaleLowerCase().includes(query));
    noteList.replaceChildren();

    for (const note of visibleNotes) {
      const row = document.createElement("div");
      row.className = `note-row${note.id === selectedId ? " is-active" : ""}`;

      const select = document.createElement("button");
      select.className = "note-select";
      select.type = "button";
      select.textContent = note.title || "Untitled";
      select.setAttribute("aria-current", note.id === selectedId ? "page" : "false");
      select.addEventListener("click", () => selectNote(note.id));

      const remove = document.createElement("button");
      remove.className = "note-delete";
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Delete ${note.title || "untitled note"}`);
      remove.title = "Delete note";
      remove.hidden = !canEdit;
      remove.addEventListener("click", () => deleteNote(note.id));

      row.append(select, remove);
      noteList.append(row);
    }

    listEmpty.hidden = visibleNotes.length > 0;
    listEmpty.textContent = notes.length === 0 ? "No notes yet. Add one to begin." : "No matching titles.";
  }

  function setFormattingEnabled(enabled) {
    fontFamily.disabled = !enabled;
    fontSize.disabled = !enabled;
    boldButton.disabled = !enabled;
    italicButton.disabled = !enabled;
    codeButton.disabled = !enabled;
    decreaseSizeButton.disabled = !enabled;
    increaseSizeButton.disabled = !enabled;
  }

  function rememberSelection() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    if (contentField.contains(range.commonAncestorContainer)) savedRange = range.cloneRange();
  }

  function restoreSelection() {
    contentField.focus();
    if (!savedRange || !contentField.contains(savedRange.commonAncestorContainer)) return;
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(savedRange);
  }

  function applyFormatting(command, value = null) {
    if (!selectedId) return;
    restoreSelection();
    document.execCommand(command, false, value);
    rememberSelection();
    saveSelectedNote();
    updateFormatButtons();
  }

  function adjustFontSize(amount) {
    const nextIndex = Math.min(5, Math.max(0, fontSize.selectedIndex + amount));
    fontSize.selectedIndex = nextIndex;
    applyFormatting("fontSize", fontSize.value);
  }

  function insertCodeBlock() {
    if (!selectedId) return;
    restoreSelection();
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;

    const range = selection.getRangeAt(0);
    if (!contentField.contains(range.commonAncestorContainer)) return;
    const codeText = range.toString() || "Write code here";
    range.deleteContents();

    const pre = document.createElement("pre");
    const code = document.createElement("code");
    code.textContent = codeText;
    pre.append(code);
    range.insertNode(pre);

    const nextLine = document.createElement("p");
    nextLine.append(document.createElement("br"));
    pre.after(nextLine);
    range.selectNodeContents(code);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    contentField.focus();
    rememberSelection();
    saveSelectedNote();
  }

  function updateFormatButtons() {
    boldButton.setAttribute("aria-pressed", String(document.queryCommandState("bold")));
    italicButton.setAttribute("aria-pressed", String(document.queryCommandState("italic")));
  }

  function selectNote(id) {
    const note = notes.find((item) => item.id === id);
    if (!note) return;
    selectedId = id;
    titleField.contentEditable = String(canEdit);
    contentField.contentEditable = String(canEdit);
    titleField.setAttribute("aria-readonly", String(!canEdit));
    contentField.setAttribute("aria-readonly", String(!canEdit));
    titleField.textContent = note.title;
    contentField.innerHTML = sanitizeRichText(note.content);
    fontFamily.value = "Georgia";
    fontSize.value = "3";
    savedRange = null;
    setFormattingEnabled(canEdit);
    renderList();
    closeDrawer();
  }

  function addNote() {
    if (!canEdit) return;
    const note = { id: crypto.randomUUID(), title: "Title", content: "", updatedAt: new Date().toISOString() };
    notes.unshift(note);
    if (!saveNotes()) {
      notes.shift();
      return;
    }
    selectedId = note.id;
    titleField.contentEditable = "true";
    contentField.contentEditable = "true";
    titleField.setAttribute("aria-readonly", "false");
    contentField.setAttribute("aria-readonly", "false");
    titleField.textContent = note.title;
    contentField.innerHTML = "";
    fontFamily.value = "Georgia";
    fontSize.value = "3";
    savedRange = null;
    setFormattingEnabled(true);
    renderList();
    closeDrawer();
    titleField.focus();
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(titleField);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }

  function saveSelectedNote() {
    const note = notes.find((item) => item.id === selectedId);
    if (!note) return;
    const previousTitle = note.title;
    const previousContent = note.content;
    const nextTitle = noteText(titleField).replace(/\n+/g, " ").trim();
    const nextContent = sanitizeRichText(contentField.innerHTML);
    if (nextTitle === previousTitle && nextContent === previousContent) return;
    const previousUpdatedAt = note.updatedAt;
    note.title = nextTitle;
    note.content = nextContent;
    note.updatedAt = new Date().toISOString();
    if (!saveNotes()) {
      note.title = previousTitle;
      note.content = previousContent;
      note.updatedAt = previousUpdatedAt;
      return;
    }
    if (document.activeElement === contentField) rememberSelection();
    if (note.title !== previousTitle) renderList();
  }

  function deleteNote(id) {
    if (!canEdit) return;
    const note = notes.find((item) => item.id === id);
    if (!note || !window.confirm(`Delete "${note.title || "Untitled"}"? This can't be undone.`)) return;
    const previousNotes = notes;
    notes = notes.filter((item) => item.id !== id);
    if (!saveNotes()) {
      notes = previousNotes;
      return;
    }
    if (selectedId === id) {
      selectedId = null;
      titleField.contentEditable = "false";
      contentField.contentEditable = "false";
      titleField.setAttribute("aria-readonly", "true");
      contentField.setAttribute("aria-readonly", "true");
      titleField.textContent = "";
      contentField.innerHTML = "";
      savedRange = null;
      setFormattingEnabled(false);
    }
    renderList();
  }

  function showToast(message) {
    toast.textContent = message;
    toast.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { toast.hidden = true; }, 2800);
  }

  function openDrawer() {
    shell.classList.add("drawer-open");
    drawerScrim.hidden = false;
    menuButton.setAttribute("aria-expanded", "true");
    sidebar.querySelector("#add-button").focus();
  }

  function closeDrawer() {
    shell.classList.remove("drawer-open");
    drawerScrim.hidden = true;
    menuButton.setAttribute("aria-expanded", "false");
  }

  function insertPlainText(event, field) {
    event.preventDefault();
    const text = event.clipboardData.getData("text/plain");
    document.execCommand("insertText", false, field === titleField ? text.replace(/\r?\n/g, " ") : text);
  }

  fontFamily.addEventListener("mousedown", rememberSelection);
  fontFamily.addEventListener("change", () => applyFormatting("fontName", fontFamily.value));
  fontSize.addEventListener("mousedown", rememberSelection);
  fontSize.addEventListener("change", () => applyFormatting("fontSize", fontSize.value));
  [boldButton, italicButton, codeButton, decreaseSizeButton, increaseSizeButton].forEach((button) => {
    button.addEventListener("mousedown", (event) => {
      event.preventDefault();
      rememberSelection();
    });
  });
  boldButton.addEventListener("click", () => applyFormatting("bold"));
  italicButton.addEventListener("click", () => applyFormatting("italic"));
  codeButton.addEventListener("click", insertCodeBlock);
  decreaseSizeButton.addEventListener("click", () => adjustFontSize(-1));
  increaseSizeButton.addEventListener("click", () => adjustFontSize(1));
  document.addEventListener("selectionchange", () => {
    if (document.activeElement === contentField) {
      rememberSelection();
      updateFormatButtons();
    }
  });
  addButton.addEventListener("click", addNote);
  searchInput.addEventListener("input", renderList);
  titleField.addEventListener("input", saveSelectedNote);
  contentField.addEventListener("input", saveSelectedNote);
  titleField.addEventListener("keydown", (event) => {
    if (event.key === "Enter") event.preventDefault();
  });
  titleField.addEventListener("paste", (event) => insertPlainText(event, titleField));
  contentField.addEventListener("paste", (event) => insertPlainText(event, contentField));
  menuButton.addEventListener("click", openDrawer);
  drawerScrim.addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeDrawer();
  });

  renderList();
  setFormattingEnabled(false);
  if (notes.length) selectNote(notes[0].id);
  if (syncApi) {
    initializeSync();
  } else {
    loadPublishedNotes().then(() => {
      if (!selectedId && notes.length) selectNote(notes[0].id);
    });
  }
})();
