"use strict";

const FRONTEND_BUILD = "2026-10-17-answer-indicator-1";

const byId = id => document.getElementById(id);

const ui = {
  queryForm: byId("queryForm"),
  question: byId("question"),
  askButton: byId("askBtn"),
  clearButton: byId("clearBtn"),
  answer: byId("answer"),
  sources: byId("sources"),
  fileList: byId("fileList"),
  badge: byId("collectionBadge"),
  uploadForm: byId("uploadForm"),
  fileInput: byId("file"),
  dropZone: byId("dropZone"),
  selectedFile: byId("selectedFile"),
  uploadButton: byId("uploadBtn"),
  uploadStatus: byId("uploadStatus"),
  errorPanel: byId("errorPanel"),
  errorTitle: byId("errorTitle"),
  errorMessage: byId("errorMessage"),
  errorDetailsBlock: byId("errorDetailsBlock"),
  errorDetails: byId("errorDetails"),
  dismissErrorButton: byId("dismissErrorBtn"),
  overlay: byId("indexingOverlay"),
  modal: byId("indexingModal"),
  indexingFile: byId("indexingFile"),
  elapsedTime: byId("elapsedTime")
};

const state = {
  selectedFile: null,
  asking: false,
  uploading: false,
  refreshing: false,
  modalTimer: null,
  statusTimer: null,
  startedAt: 0,
  previousFocus: null
};

class ApiError extends Error {
  constructor(message, details = "") {
    super(message);
    this.name = "ApiError";
    this.details = details;
  }
}

function element(tag, className = "", text = "") {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== "") node.textContent = text;
  return node;
}

function readable(value) {
  if (typeof value === "string") return value;

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

async function requestJson(url, options = {}) {
  let response;

  try {
    response = await fetch(url, {
      ...options,
      headers: {
        Accept: "application/json",
        ...(options.headers || {})
      }
    });
  } catch {
    throw new ApiError(
      "Не удалось связаться с сервером.",
      `${options.method || "GET"} ${url}\n` +
      "Проверьте контейнер rag и соединение."
    );
  }

  const raw = await response.text();
  let data;

  try {
    data = JSON.parse(raw);
  } catch {
    throw new ApiError(
      response.ok
        ? "Сервер вернул ответ не в формате JSON."
        : `Сервер вернул HTTP ${response.status}.`,
      `${options.method || "GET"} ${url}\n` +
      `${raw.slice(0, 8000) || "Пустой ответ"}\n\n` +
      "Проверьте: docker compose logs --tail=100 rag"
    );
  }

  if (!response.ok) {
    throw new ApiError(
      data && data.detail
        ? readable(data.detail)
        : `Ошибка сервера: HTTP ${response.status}.`,
      readable(data)
    );
  }

  if (!data || typeof data !== "object") {
    throw new ApiError("Неожиданный формат ответа сервера.", raw);
  }

  return data;
}

function showError(title, error, scroll = true) {
  ui.errorTitle.textContent = title;
  ui.errorMessage.textContent =
    error.message || "Неизвестная ошибка.";

  ui.errorDetails.textContent = [
    `Frontend: ${FRONTEND_BUILD}`,
    error.details || ""
  ].filter(Boolean).join("\n\n");

  ui.errorDetailsBlock.hidden = false;
  ui.errorDetailsBlock.open = false;
  ui.errorPanel.hidden = false;

  if (scroll) {
    ui.errorPanel.scrollIntoView({
      block: "nearest",
      behavior: "smooth"
    });
  }

  console.error(title, error);
}

function hideError() {
  ui.errorPanel.hidden = true;
  ui.errorMessage.textContent = "";
  ui.errorDetails.textContent = "";
}

function updateButtons() {
  const busy = state.asking || state.uploading;

  ui.askButton.disabled = busy;
  ui.uploadButton.disabled = busy;
  ui.clearButton.disabled = busy;
  ui.fileInput.disabled = busy;

  ui.askButton.textContent = state.asking
    ? "Поиск и формирование ответа…"
    : "Найти и сформировать ответ";

  ui.uploadButton.textContent = state.uploading
    ? "Идёт индексация…"
    : "Загрузить и проиндексировать";
}

function documentUrl(path, page = null) {
  const pathString = String(path || "");
  const encoded = pathString
    .split("/")
    .map(part => encodeURIComponent(part))
    .join("/");

  let url = `/api/document/${encoded}`;
  const number = Number(page);

  if (
    pathString.toLowerCase().endsWith(".pdf") &&
    Number.isInteger(number) &&
    number > 0
  ) {
    url += `#page=${number}`;
  }

  return url;
}

function fileSize(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size)) return "Размер неизвестен";

  return size < 1048576
    ? `${(size / 1024).toFixed(1)} КБ`
    : `${(size / 1048576).toFixed(2)} МБ`;
}

function fileDate(file) {
  let value = file.modified_at ?? file.mtime;

  if (value === undefined || value === null || value === "") {
    return "Дата не передана";
  }

  if (
    typeof value === "number" ||
    (
      typeof value === "string" &&
      /^\d+(\.\d+)?$/.test(value)
    )
  ) {
    value = Number(value);
    if (value < 100000000000) value *= 1000;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Дата не передана";

  return date.toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

/* Безопасное ограниченное форматирование Markdown. */
function appendInline(parent, source, depth = 0) {
  const text = String(source);

  if (depth > 8) {
    parent.append(document.createTextNode(text));
    return;
  }

  const pattern =
    /(`[^`\n]+`|\*\*[\s\S]+?\*\*|__[\s\S]+?__|\*[^*\n]+\*|_[^_\n]+_)/g;

  let position = 0;

  for (const tokenMatch of text.matchAll(pattern)) {
    parent.append(
      document.createTextNode(text.slice(position, tokenMatch.index))
    );

    const token = tokenMatch[0];
    let node;

    if (token.startsWith("`")) {
      node = element("code", "", token.slice(1, -1));
    } else if (
      token.startsWith("**") ||
      token.startsWith("__")
    ) {
      node = element("strong");
      appendInline(node, token.slice(2, -2), depth + 1);
    } else {
      node = element("em");
      appendInline(node, token.slice(1, -1), depth + 1);
    }

    parent.append(node);
    position = tokenMatch.index + token.length;
  }

  parent.append(document.createTextNode(text.slice(position)));
}

function renderMarkdown(target, markdown) {
  const lines = String(markdown)
    .replace(/\r\n?/g, "\n")
    .split("\n");

  const output = document.createDocumentFragment();

  let paragraph = [];
  let list = null;
  let lastItem = null;
  let inCode = false;
  let codeLines = [];

  function flushParagraph() {
    if (!paragraph.length) return;
    const p = element("p");
    appendInline(p, paragraph.join("\n"));
    output.append(p);
    paragraph = [];
  }

  function closeList() {
    list = null;
    lastItem = null;
  }

  function flushCode() {
    const pre = element("pre");
    pre.append(element("code", "", codeLines.join("\n")));
    output.append(pre);
    codeLines = [];
  }

  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      flushParagraph();
      closeList();
      if (inCode) flushCode();
      inCode = !inCode;
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      flushParagraph();
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+)$/);
    const ordered = line.match(/^\s*(\d+)[.)]\s+(.+)$/);
    const unordered = line.match(/^\s*[-+*]\s+(.+)$/);
    const quote = line.match(/^\s*>\s?(.*)$/);

    if (heading) {
      flushParagraph();
      closeList();
      const level = Math.min(6, heading.length + 2);[1]
      const h = element(`h${level}`);
      appendInline(h, heading.replace(/\s+#+\s*$/, ""));[2]
      output.append(h);
      continue;
    }

    if (/^\s*(---+|\*\*\*+|___+)\s*$/.test(line)) {
      flushParagraph();
      closeList();
      output.append(element("hr"));
      continue;
    }

    if (ordered || unordered) {
      flushParagraph();
      const type = ordered ? "OL" : "UL";

      if (!list || list.tagName !== type) {
        list = element(type.toLowerCase());
        if (ordered) list.start = Number(ordered[1]) || 1;
        output.append(list);
      }

      lastItem = element("li");
      appendInline(lastItem, ordered ? ordered : unordered);[1][2]
      list.append(lastItem);
      continue;
    }

    if (quote) {
      flushParagraph();
      closeList();
      const blockquote = element("blockquote");
      appendInline(blockquote, quote);[1]
      output.append(blockquote);
      continue;
    }

    if (list && lastItem && /^\s{2,}\S/.test(line)) {
      lastItem.append(document.createTextNode(" "));
      appendInline(lastItem, line.trim());
      continue;
    }

    closeList();
    paragraph.push(line);
  }

  if (inCode) flushCode();
  flushParagraph();
  target.replaceChildren(output);
}

/* ==========================================================
   Построение дерева документов
   ========================================================== */

// Раскрытые папки сохраняются между автоматическими обновлениями.
// После перезагрузки страницы все папки снова свёрнуты.
const expandedDocumentFolders = new Set();

let documentTreeNodeId = 0;

const documentNameCollator = new Intl.Collator("ru", {
  numeric: true,
  sensitivity: "base"
});

function createDocumentFolder(name = "", path = "") {
  return {
    name: name,
    path: path,
    folders: new Map(),
    files: [],
    totalFiles: 0
  };
}

function buildDocumentTree(files) {
  const root = createDocumentFolder();

  for (const file of files) {
    const rawPath = String(
      file.relative_path || file.name || ""
    );

    // Нормализуем разделители, сохраняя реальные имена сегментов.
    const parts = rawPath
      .replace(/\\/g, "/")
      .split("/")
      .filter(part => part !== "");

    if (parts.length === 0) {
      continue;
    }

    // Некорректные относительные пути в дерево не включаем.
    if (parts.some(part => part === "." || part === "..")) {
      console.warn(
        "RAG-MD: пропущен некорректный путь документа:",
        rawPath
      );
      continue;
    }

    const fileName = parts[parts.length - 1];
    const relativePath = parts.join("/");

    let currentFolder = root;
    currentFolder.totalFiles += 1;

    const folderPathParts = [];

    for (const folderName of parts.slice(0, -1)) {
      folderPathParts.push(folderName);

      const folderPath = folderPathParts.join("/");

      if (!currentFolder.folders.has(folderName)) {
        currentFolder.folders.set(
          folderName,
          createDocumentFolder(folderName, folderPath)
        );
      }

      currentFolder = currentFolder.folders.get(folderName);
      currentFolder.totalFiles += 1;
    }

    currentFolder.files.push({
      ...file,
      name: file.name || fileName,
      relative_path: relativePath
    });
  }

  return root;
}

function getDocumentIcon(file) {
  const fileName = String(
    file.name || file.relative_path || ""
  ).trim();

  const dotPosition = fileName.lastIndexOf(".");

  const extension = dotPosition >= 0
    ? fileName.slice(dotPosition + 1).toLowerCase()
    : "";

  const icons = {
    pdf: {
      symbol: "📕",
      label: "PDF"
    },
    djvu: {
      symbol: "📘",
      label: "DjVu"
    },
    djv: {
      symbol: "📘",
      label: "DjVu"
    },
    txt: {
      symbol: "📝",
      label: "Текстовый документ"
    },
    md: {
      symbol: "📑",
      label: "Markdown"
    }
  };

  return icons[extension] || {
    symbol: "📄",
    label: "Документ"
  };
}

function createDocumentFileLink(file) {
  const path = file.relative_path || file.name;

  const link = element("a", "file-item");

  link.href = documentUrl(path);
  link.target = "_blank";
  link.rel = "noopener noreferrer";

  link.title = [
    `Открыть: ${path}`,
    `Изменён: ${fileDate(file)}`
  ].join("\n");

  const iconData = getDocumentIcon(file);

  const icon = element(
    "span",
    "document-icon",
    iconData.symbol
  );

  icon.setAttribute("aria-hidden", "true");
  icon.title = iconData.label;

  const info = element("div", "file-info");

  info.append(
    element(
      "span",
      "file-name",
      file.name || path
    )
  );

  const size = Number(file.size_mb);

  const sizeText = Number.isFinite(size)
    ? `${size.toFixed(2)} МБ`
    : "Размер неизвестен";

  info.append(
    element(
      "span",
      "file-meta",
      `${sizeText} · ${fileDate(file)}`
    )
  );

  let fileType = file.type;

  if (!fileType) {
    const fileName = String(file.name || path);
    const dotPosition = fileName.lastIndexOf(".");

    fileType = dotPosition >= 0
      ? fileName.slice(dotPosition + 1).toUpperCase()
      : "FILE";
  }

  link.append(
    icon,
    info,
    element("span", "file-type", fileType)
  );

  return link;
}

function renderDocumentTree(folder, isRoot = true, expandForSearch = false) {
  const list = element(
    "ul",
    isRoot ? "docs-tree" : "folder-children"
  );

  const sortedFolders = Array
    .from(folder.folders.values())
    .sort((a, b) =>
      documentNameCollator.compare(a.name, b.name)
    );

  // Сначала папки, затем файлы текущего уровня.
  for (const childFolder of sortedFolders) {
    const item = element("li", "folder-item");

    const button = element("button", "folder-toggle");
    button.type = "button";
    button.title = childFolder.path;

    const expanded = expandForSearch || expandedDocumentFolders.has(
      childFolder.path
    );

    const sign = element(
      "span",
      "folder-sign",
      expanded ? "−" : "+"
    );
    sign.setAttribute("aria-hidden", "true");

    const icon = element(
      "span",
      "folder-icon",
      expanded ? "📂" : "📁"
    );
    icon.setAttribute("aria-hidden", "true");

    const name = element(
      "span",
      "folder-name",
      childFolder.name
    );

    const count = element(
      "span",
      "folder-count",
      String(childFolder.totalFiles)
    );

    count.title = "Документов в папке и подпапках";

    const children = renderDocumentTree(
      childFolder,
      false,
      expandForSearch
    );

    documentTreeNodeId += 1;

    children.id = `docs-folder-${documentTreeNodeId}`;
    children.hidden = !expanded;

    button.setAttribute(
      "aria-expanded",
      String(expanded)
    );

    button.setAttribute(
      "aria-controls",
      children.id
    );

    button.append(sign, icon, name, count);

    button.addEventListener("click", () => {
      const wasExpanded =
        button.getAttribute("aria-expanded") === "true";

      const nextExpanded = !wasExpanded;

      button.setAttribute(
        "aria-expanded",
        String(nextExpanded)
      );

      children.hidden = !nextExpanded;
      sign.textContent = nextExpanded ? "−" : "+";
      icon.textContent = nextExpanded ? "📂" : "📁";

      if (!expandForSearch) {
        if (nextExpanded) {
          expandedDocumentFolders.add(childFolder.path);
        } else {
          expandedDocumentFolders.delete(childFolder.path);
        }
      }
    });

    item.append(button, children);
    list.append(item);
  }

  const sortedFiles = folder.files
    .slice()
    .sort((a, b) =>
      documentNameCollator.compare(
        String(a.name),
        String(b.name)
      )
    );

  for (const file of sortedFiles) {
    const item = element("li", "document-item");
    item.append(createDocumentFileLink(file));
    list.append(item);
  }

  return list;
}

let cachedDocumentFiles = [];
let documentFileSearchTimer = null;

function normalizeDocumentSearch(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/\\/g, "/")
    .trim();
}

function renderFilteredDocumentTree({ preserveScroll = false } = {}) {
  const input = document.getElementById("fileSearch");
  const query = normalizeDocumentSearch(input ? input.value : "");
  const terms = query.split(/\s+/).filter(Boolean);
  const searching = terms.length > 0;
  const files = searching
    ? cachedDocumentFiles.filter(file => {
        const text = normalizeDocumentSearch(
          `${file.name || ""}\n${file.relative_path || ""}`
        );
        return terms.every(term => text.includes(term));
      })
    : cachedDocumentFiles;

  const tree = buildDocumentTree(files);
  const fullTree = buildDocumentTree(cachedDocumentFiles);
  const scrollTop = ui.fileList.scrollTop;
  const active = document.activeElement;
  const focusedPath = active instanceof HTMLElement &&
    ui.fileList.contains(active) &&
    active.classList.contains("folder-toggle") ? active.title : null;

  ui.fileList.classList.add("file-tree-container");
  ui.fileList.replaceChildren(
    tree.totalFiles
      ? renderDocumentTree(tree, true, searching)
      : element("p", "empty", searching
          ? "По вашему запросу файлы не найдены."
          : "Документы не найдены.")
  );
  ui.fileList.scrollTop = preserveScroll ? scrollTop : 0;

  if (preserveScroll && focusedPath !== null) {
    for (const button of ui.fileList.querySelectorAll(".folder-toggle")) {
      if (button.title === focusedPath) {
        button.focus({ preventScroll: true });
        break;
      }
    }
  }

  const status = document.getElementById("fileSearchStatus");
  const clear = document.getElementById("clearFileSearch");
  if (status) {
    status.hidden = !searching;
    status.textContent = searching
      ? `Найдено документов: ${tree.totalFiles} из ${fullTree.totalFiles}`
      : "";
  }
  if (clear) clear.hidden = !(input && input.value.length);
  ui.badge.textContent = `Документов: ${fullTree.totalFiles}`;
}

function initializeDocumentFileSearch() {
  let input = document.getElementById("fileSearch");

  // Если PHP ещё не изменён, создаём поле над списком автоматически.
  if (!input) {
    const wrapper = element("div", "file-search");
    const label = element("label", "visually-hidden",
      "Поиск по именам файлов и папкам");
    label.htmlFor = "fileSearch";
    const control = element("div", "file-search-control");
    const icon = element("span", "file-search-icon", "⌕");
    icon.setAttribute("aria-hidden", "true");
    input = element("input");
    input.id = "fileSearch";
    input.type = "search";
    input.placeholder = "Найти файл или папку…";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.setAttribute("aria-controls", "fileList");
    input.setAttribute("aria-describedby", "fileSearchStatus");
    const clear = element("button", "file-search-clear", "×");
    clear.id = "clearFileSearch";
    clear.type = "button";
    clear.hidden = true;
    clear.title = "Очистить поиск";
    clear.setAttribute("aria-label", "Очистить поиск файлов");
    const status = element("p", "file-search-status");
    status.id = "fileSearchStatus";
    status.hidden = true;
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    control.append(icon, input, clear);
    wrapper.append(label, control, status);
    ui.fileList.before(wrapper);
  }

  if (input.dataset.searchInitialized === "true") return;
  input.dataset.searchInitialized = "true";
  const clear = document.getElementById("clearFileSearch");

  function applySearch() {
    window.clearTimeout(documentFileSearchTimer);
    renderFilteredDocumentTree();
  }

  input.addEventListener("input", () => {
    if (clear) clear.hidden = input.value.length === 0;
    window.clearTimeout(documentFileSearchTimer);
    documentFileSearchTimer = window.setTimeout(applySearch, 150);
  });
  input.addEventListener("search", applySearch);
  input.addEventListener("keydown", event => {
    if (event.key === "Escape" || event.key === "Enter") {
      event.preventDefault();
      if (event.key === "Escape") input.value = "";
      applySearch();
    }
  });
  if (clear) {
    clear.addEventListener("click", () => {
      input.value = "";
      applySearch();
      input.focus();
    });
  }
  renderFilteredDocumentTree({ preserveScroll: true });
}

async function refreshFiles({ quiet = false } = {}) {
  if (state.refreshing || state.uploading) return;
  state.refreshing = true;
  try {
    const data = await requestJson("/api/files", { cache: "no-store" });
    if (!Array.isArray(data.files)) {
      throw new ApiError("Некорректный список файлов.", readable(data));
    }
    cachedDocumentFiles = data.files;
    renderFilteredDocumentTree({ preserveScroll: true });
  } catch (error) {
    if (!quiet) {
      ui.fileList.replaceChildren(element("p", "empty",
        "Не удалось получить список файлов."));
      ui.badge.textContent = "Список недоступен";
      showError("Ошибка получения списка файлов", error, false);
    }
  } finally {
    state.refreshing = false;
  }
}

function setUploadStatus(message, type = "", autoHide = false) {
  window.clearTimeout(state.statusTimer);
  ui.uploadStatus.textContent = message;
  ui.uploadStatus.className = `status ${type}`.trim();

  if (autoHide) {
    state.statusTimer = window.setTimeout(() => {
      ui.uploadStatus.textContent = "";
      ui.uploadStatus.className = "status";
    }, 10000);
  }
}

/*
 * Проверка расширения без match().
 * Возвращает строку имени, которую передадим серверу.
 */
function validateFile(file) {
  if (
    !file ||
    typeof file.name !== "string" ||
    typeof file.slice !== "function"
  ) {
    throw new ApiError("Не выбран корректный файл.");
  }

  const cleanName = String(file.name)
    .normalize("NFC")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .trim();

  const dotPosition = cleanName.lastIndexOf(".");

  const extension = dotPosition >= 0
    ? cleanName.slice(dotPosition + 1).trim().toLowerCase()
    : "";

  const allowed = ["pdf", "djvu", "djv", "txt", "md"];

  if (!allowed.includes(extension)) {
    throw new ApiError(
      "Неподдерживаемое расширение. Выберите PDF, DjVu, TXT или MD.",
      [
        `Имя: ${JSON.stringify(file.name)}`,
        `Нормализованное имя: ${JSON.stringify(cleanName)}`,
        `Расширение: ${extension || "отсутствует"}`,
        `MIME: ${file.type || "не передан"}`,
        `Размер: ${file.size} байт`
      ].join("\n")
    );
  }

  if (file.size === 0) {
    throw new ApiError("Выбранный файл имеет нулевой размер.");
  }

  const stem = cleanName.slice(0, dotPosition).trim() || "document";
  const uploadName = `${stem}.${extension}`.replace(/[\/\\]/g, "_");

  return uploadName;
}

function selectFile(file) {
  try {
    validateFile(file);

    state.selectedFile = file;
    ui.selectedFile.textContent =
      `${file.name} · ${fileSize(file.size)}`;

    setUploadStatus("");
    hideError();

  } catch (error) {
    state.selectedFile = null;
    ui.fileInput.value = "";
    ui.selectedFile.textContent = "";
    showError("Ошибка выбора документа", error);
  }
}

function updateElapsed() {
  const seconds = Math.floor((Date.now() - state.startedAt) / 1000);
  ui.elapsedTime.textContent =
    `Прошло: ${String(Math.floor(seconds / 60)).padStart(2, "0")}:` +
    String(seconds % 60).padStart(2, "0");
}

function openModal(name) {
  state.previousFocus = document.activeElement;
  state.startedAt = Date.now();

  ui.indexingFile.textContent = name;
  ui.overlay.hidden = false;
  document.body.classList.add("modal-open");
  document.querySelector(".container").inert = true;

  updateElapsed();
  window.clearInterval(state.modalTimer);
  state.modalTimer = window.setInterval(updateElapsed, 1000);
  ui.modal.focus();
}

function closeModal() {
  window.clearInterval(state.modalTimer);
  state.modalTimer = null;

  ui.overlay.hidden = true;
  document.body.classList.remove("modal-open");
  document.querySelector(".container").inert = false;

  if (
    state.previousFocus &&
    typeof state.previousFocus.focus === "function"
  ) {
    state.previousFocus.focus();
  }
}

async function uploadDocument(event) {
  event.preventDefault();
  if (state.uploading || state.asking) return;

  // Единственный источник выбранного файла — state.selectedFile.
  const file = state.selectedFile;

  if (!file) {
    showError(
      "Файл не выбран",
      new ApiError(
        "Выберите документ кнопкой «Выберите файл» или перетащите его в область загрузки."
      )
    );
    return;
  }

  let uploadName;

  try {
    uploadName = validateFile(file);
  } catch (error) {
    showError("Ошибка выбора документа", error);
    return;
  }

  hideError();
  state.uploading = true;
  updateButtons();
  setUploadStatus("Ожидание результата индексации…");
  openModal(file.name);

  const body = new FormData();
  body.append("file", file, uploadName);

  let failure = null;

  try {
    const data = await requestJson("/upload", {
      method: "POST",
      body
    });

    if (Array.isArray(data.errors) && data.errors.length) {
      throw new ApiError("Ошибка индексации.", readable(data.errors));
    }

    const name = data.saved || uploadName;
    const chunks = Number(data.chunks);

    if (data.status === "empty") {
      throw new ApiError(
        "Не удалось извлечь текст из документа.",
        data.reason || readable(data)
      );
    }

    if (data.status === "skipped") {
      setUploadStatus(
        `«${name}» уже проиндексирован. Повторная обработка не выполнялась.`,
        "ok",
        true
      );
    } else if (
      data.status === "indexed" ||
      (Number.isFinite(chunks) && chunks > 0)
    ) {
      setUploadStatus(
        `«${name}» успешно проиндексирован. Фрагментов: ${
          Number.isFinite(chunks) ? chunks : "—"
        }.`,
        "ok",
        true
      );
    } else {
      throw new ApiError(
        "Сервер не подтвердил успешную индексацию.",
        readable(data)
      );
    }

  } catch (error) {
    failure = error;
    setUploadStatus(
      "Индексация не завершена. Подробности — в блоке ошибок.",
      "error"
    );
  } finally {
    state.uploading = false;
    updateButtons();
    closeModal();
  }

  if (failure) {
    showError("Ошибка индексации документа", failure);
  }

  await refreshFiles({ quiet: true });
}

function renderSources(sources) {
  const fragment = document.createDocumentFragment();

  sources.forEach((source, index) => {
    const sourceNumber = index + 1;

    const article = element("article", "source source-compact");
    article.id = `source-${sourceNumber}`;

    // Позволяет перевести фокус на карточку по сноске.
    article.tabIndex = -1;

    const header = element("div", "source-head");
    const info = element("div", "source-info");

    info.append(
      element(
        "div",
        "source-title",
        `[${sourceNumber}] ${source.file_name || "Документ"}`
      )
    );

    const metadata = [];

    const page = Number(source.page);

    const hasPage =
      Number.isInteger(page) &&
      page > 0;

    if (hasPage) {
      metadata.push(`Страница файла ${page}`);
    }

    if (source.section) {
      metadata.push(`Пункт ${source.section}`);
    }

    if (!metadata.length) {
      metadata.push("Страница не указана");
    }

    info.append(
      element(
        "div",
        "file-meta",
        metadata.join(" · ")
      )
    );

    header.append(info);

    if (source.file) {
      const isPdf = String(source.file)
        .toLowerCase()
        .endsWith(".pdf");

      const link = element(
        "a",
        "page-link",
        isPdf && hasPage
          ? `Открыть страницу ${page} ↗`
          : "Открыть документ ↗"
      );

      link.href = documentUrl(source.file, source.page);
      link.target = "_blank";
      link.rel = "noopener noreferrer";

      header.append(link);
    }

    // Сырой source.text намеренно не выводим.
    // Номер чанка и численное сходство также убраны из интерфейса.
    article.append(header);
    fragment.append(article);
  });

  ui.sources.replaceChildren(fragment);

  // Не показываем разделитель, если источников нет.
  ui.sources.classList.toggle(
    "has-sources",
    sources.length > 0
  );
}

/* ==========================================================
   Переход к источнику и временная подсветка карточки
   ========================================================== */

let highlightedSourceCard = null;
let sourceHighlightTimer = null;

function highlightSourceCard(target) {
  if (!(target instanceof HTMLElement)) {
    return;
  }

  window.clearTimeout(sourceHighlightTimer);

  // Убираем выделение предыдущего источника.
  if (highlightedSourceCard) {
    highlightedSourceCard.classList.remove(
      "source-highlighted"
    );
  }

  highlightedSourceCard = target;

  target.classList.add("source-highlighted");
  target.focus({ preventScroll: true });

  const reducedMotion = window.matchMedia(
    "(prefers-reduced-motion: reduce)"
  ).matches;

  target.scrollIntoView({
    behavior: reducedMotion ? "auto" : "smooth",
    block: "center"
  });

  sourceHighlightTimer = window.setTimeout(() => {
    target.classList.remove("source-highlighted");

    if (highlightedSourceCard === target) {
      highlightedSourceCard = null;
    }

    sourceHighlightTimer = null;
  }, 3000);
}


/* ==========================================================
   Преобразование ссылок LLM [1], [2], [1, 2] в сноски
   ========================================================== */

function decorateAnswerCitations(sources) {
  const sourceCount = sources.length;

  if (!sourceCount) {
    return;
  }

  const walker = document.createTreeWalker(
    ui.answer,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        const parent = node.parentElement;

        if (!parent || !node.nodeValue) {
          return NodeFilter.FILTER_REJECT;
        }

        // Не меняем код, готовые ссылки и уже обработанные сноски.
        if (parent.closest("a, code, pre, sup, script, style")) {
          return NodeFilter.FILTER_REJECT;
        }

        return /\[\d+(?:\s*[,;]\s*\d+)*\]/.test(node.nodeValue)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      }
    }
  );

  // Сначала собираем узлы, затем изменяем DOM.
  const textNodes = [];

  while (walker.nextNode()) {
    textNodes.push(walker.currentNode);
  }

  for (const textNode of textNodes) {
    const text = textNode.nodeValue;

    const pattern = /\[(\d+(?:\s*[,;]\s*\d+)*)\]/g;
    const fragment = document.createDocumentFragment();

    let position = 0;

    for (const match of text.matchAll(pattern)) {
      fragment.append(
        document.createTextNode(
          text.slice(position, match.index)
        )
      );

      const numbers = [
        ...new Set(
          match[1]
            .split(/\s*[,;]\s*/)
            .map(Number)
        )
      ];

      const valid = numbers.every(number =>
        Number.isInteger(number) &&
        number >= 1 &&
        number <= sourceCount
      );

      if (!valid) {
        // Не превращаем несуществующий источник в рабочую ссылку.
        const invalidReference = element(
          "span",
          "citation-unresolved",
          match[0]
        );

        invalidReference.title =
          "Этот номер отсутствует среди источников, возвращённых сервером.";

        fragment.append(invalidReference);

      } else {
        const group = element(
          "sup",
          "answer-citations"
        );

        numbers.forEach(number => {
          const source = sources[number - 1];

          const link = element(
            "a",
            "answer-citation",
            `[${number}]`
          );

          link.href = `#source-${number}`;

          const description = [
            source.file_name || "Документ"
          ];

          const page = Number(source.page);

          if (Number.isInteger(page) && page > 0) {
            description.push(`страница файла ${page}`);
          }

          link.title = description.join(" · ");

          link.setAttribute(
            "aria-label",
            `Перейти к источнику ${number}: ${description.join(", ")}`
          );

			link.addEventListener("click", event => {
			  const target = document.getElementById(
				`source-${number}`
			  );

			  if (!target) {
				return;
			  }

			  event.preventDefault();
			  highlightSourceCard(target);
			});

          group.append(link);
        });

        fragment.append(group);
      }

      position = match.index + match[0].length;
    }

    fragment.append(
      document.createTextNode(
        text.slice(position)
      )
    );

    textNode.replaceWith(fragment);
  }
}

/* ==========================================================
   Индикатор ожидания ответа
   ========================================================== */

let answerTypingTimer = null;

function stopAnswerTypingIndicator() {
  window.clearInterval(answerTypingTimer);
  answerTypingTimer = null;

  ui.answer.classList.remove("is-generating");
  ui.answer.removeAttribute("aria-busy");

  // Удаляем только индикатор, не затрагивая готовый ответ.
  const indicator = ui.answer.querySelector(
    ".answer-typing"
  );

  if (indicator) {
    indicator.remove();
  }
}

function startAnswerTypingIndicator() {
  stopAnswerTypingIndicator();

  ui.answer.classList.remove("is-error");
  ui.answer.classList.add("is-generating");
  ui.answer.setAttribute("aria-busy", "true");

  const indicator = element("div", "answer-typing");

  const icon = element(
    "div",
    "answer-typing-icon",
    "✦"
  );

  icon.setAttribute("aria-hidden", "true");

  const content = element(
    "div",
    "answer-typing-content"
  );

  const title = element(
    "div",
    "answer-typing-title"
  );

  title.append(
    element(
      "span",
      "",
      "Модель формирует ответ"
    )
  );

  const dots = element(
    "span",
    "answer-typing-dots"
  );

  dots.setAttribute("aria-hidden", "true");

  for (let index = 0; index < 3; index += 1) {
    dots.append(element("span"));
  }

  title.append(dots);

  const description = element(
    "div",
    "answer-typing-description",
    "Поиск по документам и подготовка ответа. Дождитесь завершения."
  );

  const elapsed = element(
    "div",
    "answer-typing-time",
    "Прошло: 00:00"
  );

  // Не озвучиваем обновление секунд каждую секунду.
  elapsed.setAttribute("aria-hidden", "true");

  content.append(title, description, elapsed);
  indicator.append(icon, content);

  ui.answer.replaceChildren(indicator);

  const startedAt = Date.now();

  function updateElapsedTime() {
    const seconds = Math.floor(
      (Date.now() - startedAt) / 1000
    );

    const minutesText = String(
      Math.floor(seconds / 60)
    ).padStart(2, "0");

    const secondsText = String(
      seconds % 60
    ).padStart(2, "0");

    elapsed.textContent =
      `Прошло: ${minutesText}:${secondsText}`;
  }

  answerTypingTimer = window.setInterval(
    updateElapsedTime,
    1000
  );
}

async function askQuestion(event) {
  event.preventDefault();
  if (state.asking || state.uploading) return;

  const question = ui.question.value.trim();
  if (!question) {
    ui.question.focus();
    return;
  }

  hideError();
  state.asking = true;
  updateButtons();
  ui.sources.replaceChildren();
  ui.sources.classList.remove("has-sources");

  try {
    startAnswerTypingIndicator();

    const data = await requestJson("/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, top_k: 8 })
    });

    stopAnswerTypingIndicator();

    const sources = Array.isArray(data.sources) ? data.sources : [];
    renderMarkdown(ui.answer, data.answer || "Сервер не вернул текст ответа.");
    renderSources(sources);
    decorateAnswerCitations(sources);

  } catch (error) {
    stopAnswerTypingIndicator();
    ui.answer.classList.add("is-error");
    ui.answer.textContent =
      "Не удалось сформировать ответ. Подробности — в блоке ошибок.";
    showError("Ошибка поиска или генерации ответа", error);
  } finally {
    stopAnswerTypingIndicator();
    state.asking = false;
    updateButtons();
  }
}

/* Все обработчики регистрируются один раз. */
ui.queryForm.addEventListener("submit", askQuestion);
ui.uploadForm.addEventListener("submit", uploadDocument);
ui.dismissErrorButton.addEventListener("click", hideError);

ui.clearButton.addEventListener("click", () => {
  if (state.asking || state.uploading) return;

  ui.question.value = "";
  ui.answer.classList.remove("is-error");
  ui.answer.textContent =
    "Задайте вопрос по нормативной базе. Здесь появится ответ и найденные фрагменты документов.";

  ui.sources.replaceChildren();
  ui.sources.classList.remove("has-sources");
  hideError();
  ui.question.focus();
});

ui.question.addEventListener("keydown", event => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    if (!state.asking && !state.uploading) {
      ui.queryForm.requestSubmit();
    }
  }
});

ui.fileInput.addEventListener("change", event => {
  const files = event.currentTarget.files;

  if (!files || files.length === 0) {
    state.selectedFile = null;
    ui.selectedFile.textContent = "";
    return;
  }

  selectFile(files[0]);
});

["dragenter", "dragover"].forEach(type => {
  ui.dropZone.addEventListener(type, event => {
    event.preventDefault();

    if (!state.uploading && !state.asking) {
      ui.dropZone.classList.add("dragover");
    }
  });
});

ui.dropZone.addEventListener("dragleave", event => {
  const related = event.relatedTarget;

  if (!(related instanceof Node) || !ui.dropZone.contains(related)) {
    ui.dropZone.classList.remove("dragover");
  }
});

ui.dropZone.addEventListener("drop", event => {
  event.preventDefault();
  ui.dropZone.classList.remove("dragover");

  if (state.uploading || state.asking) return;

  const files = event.dataTransfer
    ? event.dataTransfer.files
    : null;

  if (!files || files.length === 0) return;

  if (files.length !== 1) {
    showError(
      "Выберите один документ",
      new ApiError("Файлы загружаются по одному.")
    );
    return;
  }

  ui.fileInput.value = "";
  selectFile(files[0]);
});

document.addEventListener("keydown", event => {
  if (state.uploading && ["Escape", "Tab"].includes(event.key)) {
    event.preventDefault();
    ui.modal.focus();
  }
});

window.addEventListener("beforeunload", event => {
  if (state.uploading) {
    event.preventDefault();
    event.returnValue = "";
  }
});

window.setInterval(() => {
  if (!document.hidden && !state.uploading && !state.asking) {
    refreshFiles({ quiet: true });
  }
}, 30000);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && !state.uploading) {
    refreshFiles({ quiet: true });
  }
});

console.info("RAG-MD frontend:", FRONTEND_BUILD);

updateButtons();
refreshFiles();

/* ==========================================================
   Сворачивание блоков правой колонки
   ========================================================== */

(function initializeSidebarPanels() {
  function initialize() {
    const panels = [
      {
        buttonId: "filesToggle",
        panelId: "filesPanel"
      },
      {
        buttonId: "uploadToggle",
        panelId: "uploadPanel"
      }
    ];

    panels.forEach(function (configuration) {
      const button = document.getElementById(
        configuration.buttonId
      );

      const panel = document.getElementById(
        configuration.panelId
      );

      if (!button || !panel) {
        console.warn(
          "RAG-MD: не найден сворачиваемый блок",
          configuration
        );
        return;
      }

      // Защита от повторной регистрации обработчика.
      if (button.dataset.collapseInitialized === "true") {
        return;
      }

      button.dataset.collapseInitialized = "true";

      // При каждой загрузке страницы оба блока закрыты.
      // Состояние предыдущего посещения не сохраняем.
      button.setAttribute("aria-expanded", "false");
      panel.hidden = true;

      button.addEventListener("click", function () {
        const expanded =
          button.getAttribute("aria-expanded") === "true";

        const nextExpanded = !expanded;

        button.setAttribute(
          "aria-expanded",
          String(nextExpanded)
        );

        panel.hidden = !nextExpanded;
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener(
      "DOMContentLoaded",
      initialize,
      { once: true }
    );
  } else {
    initialize();
  }
})();

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeDocumentFileSearch, { once: true });
} else {
  initializeDocumentFileSearch();
}
