"use strict";

jQuery(function ($) {

  const FRONTEND_BUILD = "2026-10-31-indexing-2";

  const byId = id => $(`#${id}`);

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
    indexingFile: byId("indexingFile"),
    elapsedTime: byId("elapsedTime")
  };

  const state = {
    selectedFile: null,
    asking: false,
    uploading: false,
    refreshing: false,
    indexingTimer: null,
    statusTimer: null,
    startedAt: 0
  };

  class ApiError extends Error {
    constructor(message, details = "") {
      super(message);
      this.name = "ApiError";
      this.details = details;
    }
  }

  function element(tag, className = "", text = "") {
    return $("<" + tag + ">").addClass(className).text(text);
  }

  function svgIcon(name, className = "") {
    const svg = $(document.createElementNS("http://www.w3.org/2000/svg", "svg")).addClass("icon " + className)
      .attr({ viewBox: "0 0 24 24", "aria-hidden": "true" });
    const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
    use.setAttribute("href", "/assets/icons.svg#" + name); svg.append(use);
    return svg;
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
    const method = options.method || "GET";
    const isForm = options.body instanceof FormData;
    const response = await new Promise((resolve, reject) => {
      $.ajax({
        url,
        method,
        data: options.body,
        // Parse JSON ourselves so HTTP errors retain their diagnostic response body.
        dataType: "text",
        processData: false,
        contentType: isForm ? false : options.headers?.["Content-Type"] || false,
        headers: { Accept: "application/json" },
        cache: options.cache !== "no-store"
      }).done((raw, status, xhr) => {
        resolve({ raw, status: xhr.status, ok: true });
      }).fail(xhr => {
        if (!xhr.status) {
          reject(new ApiError(
            "Не удалось связаться с сервером.",
            method + " " + url + "\nПроверьте контейнер rag и соединение."
          ));
          return;
        }
        resolve({ raw: xhr.responseText || "", status: xhr.status, ok: false });
      });
    });
    const { raw } = response;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new ApiError(
        response.ok
          ? "Сервер вернул ответ не в формате JSON."
          : "Сервер вернул HTTP " + response.status + ".",
        method + " " + url + "\n" + (raw.slice(0, 8000) || "Пустой ответ") +
        "\n\nПроверьте: docker compose logs --tail=100 rag"
      );
    }
    if (!response.ok) {
      throw new ApiError(
        data?.detail ? readable(data.detail) : "Ошибка сервера: HTTP " + response.status + ".",
        readable(data)
      );
    }
    if (!data || typeof data !== "object") {
      throw new ApiError("Неожиданный формат ответа сервера.", raw);
    }
    return data;
  }

  function showError(title, error, scroll = true) {
    ui.errorTitle.text(title);
    ui.errorMessage.text(error.message || "Неизвестная ошибка.");

    ui.errorDetails.text([
      `Frontend: ${FRONTEND_BUILD}`,
      error.details || ""
    ].filter(Boolean).join("\n\n"));

    ui.errorDetailsBlock.prop("hidden", false);
    ui.errorDetailsBlock.prop("open", false);
    ui.errorPanel.prop("hidden", false);

    if (scroll) {
      ui.errorPanel.get(0).scrollIntoView({
        block: "nearest",
        behavior: "smooth"
      });
    }

    console.error(title, error);
  }

  function hideError() {
    ui.errorPanel.prop("hidden", true);
    ui.errorMessage.text("");
    ui.errorDetails.text("");
  }

  function updateButtons() {
    const busy = state.asking || state.uploading;

    ui.askButton.prop("disabled", busy || !historyReady);
    byId("reindexBtn").prop("disabled", busy);
    byId("clearHistoryBtn").prop("disabled", state.asking || !historyReady);
    byId("deleteChatBtn").prop("disabled", state.asking);
    $(".history-item").prop("disabled", state.asking);
    ui.uploadButton.prop("disabled", busy);
    ui.clearButton.prop("disabled", busy || !historyReady);
    ui.fileInput.prop("disabled", busy);

    ui.askButton.empty().append(element("span", "", state.asking ? "Подготовка ответа…" : "Отправить"), svgIcon("send"));

    ui.uploadButton.text(state.uploading
      ? "Идёт индексация…"
      : "Загрузить и проиндексировать");
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

    const output = $(document.createDocumentFragment());

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
        const level = Math.min(6, heading[1].length + 2);
        const h = element(`h${level}`);
        appendInline(h, heading[2].replace(/\s+#+\s*$/, ""));
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

        if (!list || list.prop("tagName") !== type) {
          list = element(type.toLowerCase());
          if (ordered) list.prop("start", Number(ordered[1]) || 1);
          output.append(list);
        }

        lastItem = element("li");
        appendInline(lastItem, ordered ? ordered[2] : unordered[1]);
        list.append(lastItem);
        continue;
      }

      if (quote) {
        flushParagraph();
        closeList();
        const blockquote = element("blockquote");
        appendInline(blockquote, quote[1]);
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
    target.empty().append(output);
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
        symbol: "▧",
        label: "PDF"
      },
      djvu: {
        symbol: "▧",
        label: "DjVu"
      },
      djv: {
        symbol: "▧",
        label: "DjVu"
      },
      txt: {
        symbol: "▤",
        label: "Текстовый документ"
      },
      md: {
        symbol: "▤",
        label: "Markdown"
      }
    };

    return icons[extension] || {
      symbol: "▧",
      label: "Документ"
    };
  }

  function createDocumentFileLink(file) {
    const path = file.relative_path || file.name;

    const link = element("a", "file-item");

    link.prop("href", documentUrl(path));
    link.prop("target", "_blank");
    link.prop("rel", "noopener noreferrer");

    link.prop("title", [
      `Открыть: ${path}`,
      `Изменён: ${fileDate(file)}`
    ].join("\n"));

    const iconData = getDocumentIcon(file);

    const icon = element(
      "span",
      "document-icon",
      ""
    ).append(svgIcon("document")).addClass("document-icon-" + (String(file.type || file.name.split(".").pop()).toLowerCase()));

    icon.attr("aria-hidden", "true");
    icon.prop("title", iconData.label);

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
      button.prop("type", "button");
      button.prop("title", childFolder.path);

      const expanded = expandForSearch || expandedDocumentFolders.has(
        childFolder.path
      );

      const sign = element(
        "span",
        "folder-sign",
        ""
      ).append(svgIcon("chevron"));
      sign.attr("aria-hidden", "true");

      const icon = element(
        "span",
        "folder-icon",
        ""
      ).append(svgIcon("folder"));
      icon.attr("aria-hidden", "true");

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

      count.prop("title", "Документов в папке и подпапках");

      const children = renderDocumentTree(
        childFolder,
        false,
        expandForSearch
      );

      documentTreeNodeId += 1;

      children.prop("id", `docs-folder-${documentTreeNodeId}`);
      children.prop("hidden", !expanded);

      button.attr(
        "aria-expanded",
        String(expanded)
      );

      button.attr(
        "aria-controls",
        children.prop("id")
      );

      button.append(sign, icon, name, count);

      button.on("click", () => {
        const wasExpanded =
          button.attr("aria-expanded") === "true";

        const nextExpanded = !wasExpanded;

        button.attr(
          "aria-expanded",
          String(nextExpanded)
        );

        children.prop("hidden", !nextExpanded);



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
    const input = byId("fileSearch");
    const query = normalizeDocumentSearch(input.val());
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
    const scrollTop = ui.fileList.scrollTop();
    const active = document.activeElement;
    const focusedPath = active instanceof HTMLElement &&
      $.contains(ui.fileList.get(0), active) &&
      $(active).hasClass("folder-toggle") ? active.title : null;

    ui.fileList.addClass("file-tree-container");
    ui.fileList.empty().append(
      tree.totalFiles
        ? renderDocumentTree(tree, true, searching)
        : element("p", "empty", searching
            ? "По вашему запросу файлы не найдены."
            : "Документы не найдены.")
    );
    ui.fileList.scrollTop(preserveScroll ? scrollTop : 0);

    if (preserveScroll && focusedPath !== null) {
      for (const button of ui.fileList.find(".folder-toggle")) {
        if ($(button).prop("title") === focusedPath) {
          button.focus({ preventScroll: true });
          break;
        }
      }
    }

    const status = byId("fileSearchStatus");
    const clear = byId("clearFileSearch");
    if (status.length) {
      status.prop("hidden", !searching);
      status.text(searching
        ? `Найдено документов: ${tree.totalFiles} из ${fullTree.totalFiles}`
        : "");
    }
    if (clear.length) clear.prop("hidden", !input.val().length);
    ui.badge.text(`Документов: ${fullTree.totalFiles}`);
  }

  function initializeFileListResize() {
    const handle = byId("filesResizeHandle");
    const minimum = 160, maximum = 1600, defaultHeight = 280;
    function setHeight(value, save = false) {
      const height = Math.max(minimum, Math.min(maximum, Math.round(value)));
      ui.fileList.css("height", height + "px");
      handle.attr({ "aria-valuenow": height, "aria-valuetext": "Высота списка: " + height + " пикселей" });
      if (save) try { localStorage.setItem("ragmd.fileListHeight.v1", String(height)); } catch { /* Optional layout preference. */ }
    }
    let saved;
    try { saved = Number(localStorage.getItem("ragmd.fileListHeight.v1")); } catch { /* Use default height. */ }
    setHeight(Number.isFinite(saved) && saved >= minimum ? saved : defaultHeight);
    let drag = null;
    handle.on("pointerdown", event => {
      const pointer = event.originalEvent;
      if (pointer.button !== 0) return;
      event.preventDefault();
      drag = { y: pointer.clientY, height: ui.fileList.outerHeight(), id: pointer.pointerId };
      handle.get(0).setPointerCapture(pointer.pointerId);
      handle.addClass("is-dragging");
    });
    handle.on("pointermove", event => {
      const pointer = event.originalEvent;
      if (!drag || pointer.pointerId !== drag.id) return;
      setHeight(drag.height + pointer.clientY - drag.y);
    });
    handle.on("pointerup pointercancel lostpointercapture", () => {
      if (!drag) return;
      drag = null; handle.removeClass("is-dragging");
      setHeight(ui.fileList.outerHeight(), true);
    });
    handle.on("keydown", event => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const current = ui.fileList.outerHeight();
      setHeight(event.key === "Home" ? defaultHeight : event.key === "End" ? maximum :
        current + (event.key === "ArrowDown" ? 40 : -40), true);
    });
  }

  let summaryRefreshing = false;
  async function refreshIndexSummary() {
    if (summaryRefreshing) return;
    summaryRefreshing = true;
    try {
      const data = await requestJson("/api/indexing/summary", { cache: "no-store" });
      if (!Number.isInteger(data.indexed_documents) || !Number.isInteger(data.total_documents)) throw new ApiError("Некорректная сводка индексации");
      byId("indexingSummaryValue").text(data.indexed_documents + " / " + data.total_documents);
      byId("indexingSummaryHint").text("проиндексировано / всего документов");
    } catch {
      byId("indexingSummaryValue").text("— / " + cachedDocumentFiles.length);
      byId("indexingSummaryHint").text("Число проиндексированных документов недоступно");
    } finally { summaryRefreshing = false; }
  }

  function initializeDocumentFileSearch() {
    const input = byId("fileSearch");
    const clear = byId("clearFileSearch");
    function applySearch() {
      window.clearTimeout(documentFileSearchTimer);
      renderFilteredDocumentTree();
    }
    input.on("input", () => {
      clear.prop("hidden", input.val().length === 0);
      window.clearTimeout(documentFileSearchTimer);
      documentFileSearchTimer = window.setTimeout(applySearch, 150);
    }).on("search", applySearch).on("keydown", event => {
      if (event.key === "Escape" || event.key === "Enter") {
        event.preventDefault();
        if (event.key === "Escape") input.val("");
        applySearch();
      }
    });
    clear.on("click", () => {
      input.val("");
      applySearch();
      input.trigger("focus");
    });
    renderFilteredDocumentTree();
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
      refreshIndexSummary();
    } catch (error) {
      if (!quiet) {
        ui.fileList.empty().append(element("p", "empty",
          "Не удалось получить список файлов."));
        ui.badge.text("Список недоступен");
        showError("Ошибка получения списка файлов", error, false);
      }
    } finally {
      state.refreshing = false;
    }
  }

  function setUploadStatus(message, type = "", autoHide = false) {
    window.clearTimeout(state.statusTimer);
    ui.uploadStatus.text(message);
    ui.uploadStatus.attr("class", `status ${type}`.trim());

    if (autoHide) {
      state.statusTimer = window.setTimeout(() => {
        ui.uploadStatus.text("");
        ui.uploadStatus.attr("class", "status");
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
      ui.selectedFile.text(`${file.name} · ${fileSize(file.size)}`);

      setUploadStatus("");
      hideError();

    } catch (error) {
      state.selectedFile = null;
      ui.fileInput.val("");
      ui.selectedFile.text("");
      showError("Ошибка выбора документа", error);
    }
  }

  const INDEXING_ACTIVE = ["running", "pause_requested", "paused"];
  const INDEXING_STAGES = { preparing: "Подготовка", hashing: "Проверка файла", extracting: "Извлечение текста",
    ocr: "Распознавание страниц", embedding: "Построение эмбеддингов", saving: "Запись в базу" };

  function duration(seconds) {
    const value = Math.max(0, Math.round(seconds || 0));
    if (value >= 3600) return Math.floor(value / 3600) + " ч " + Math.ceil(value % 3600 / 60) + " мин";
    if (value >= 60) return Math.floor(value / 60) + " мин " + value % 60 + " с";
    return value + " с";
  }

  function renderIndexingJob(job) {
    state.indexingJob = job;
    if (!INDEXING_ACTIVE.includes(job.state)) refreshIndexSummary();
    const active = INDEXING_ACTIVE.includes(job.state);
    const paused = ["paused", "pause_requested"].includes(job.state);
    byId("indexingState").text({
      running: "Идёт индексация…", pause_requested: "Приостанавливаем…", paused: "Индексация на паузе",
      completed: job.result?.errors?.length ? "Завершено с ошибками" : "Индексация завершена",
      failed: "Ошибка индексации"
    }[job.state] || "Подготовка…");
    byId("indexingCount").prop("hidden", false).text("Обработано " + job.completed_files + " из " + job.total_files);
    const stageCount = job.stage_total > 0 ? " · " + job.stage_done + " из " + job.stage_total : "";
    ui.indexingFile.text(job.state === "pause_requested" ? "Ожидаем завершения текущего этапа…" :
      job.current_file ? job.current_file + (active ? " · " + (INDEXING_STAGES[job.stage] || "") + stageCount : "") : "Обработка документов базы");
    const progress = byId("indexingProgress").prop("hidden", false).removeClass("indeterminate");
    const percent = job.total_files ? Math.round(job.completed_files / job.total_files * 100) : job.state === "completed" ? 100 : 0;
    progress.attr({ "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": percent,
      "aria-valuetext": "Обработано " + job.completed_files + " из " + job.total_files });
    progress.find("span").css("width", percent + "%");
    ui.elapsedTime.prop("hidden", false).text("В работе: " + duration(job.elapsed_seconds));
    byId("indexingEta").prop("hidden", false).text(job.state === "paused" ?
      Number.isFinite(job.estimated_remaining_seconds) ? "После снятия паузы: ≈ " + duration(job.estimated_remaining_seconds) : "Расчёт продолжится после снятия паузы" :
      job.state === "completed" ? "Обработка завершена" : job.state === "failed" ? "Обработка прервана" :
      Number.isFinite(job.estimated_remaining_seconds) ? "До окончания: ≈ " + duration(job.estimated_remaining_seconds) : "Оцениваем время…");
    const button = byId("pauseIndexingBtn").prop("hidden", !active);
    button.empty().append(svgIcon(paused ? "play" : "pause"), element("span", "", paused ? "Продолжить" : "Пауза"));
  }

  function startIndexingIndicator(name) {
    ui.indexingFile.text(name);
    byId("indexingState").text("Запуск индексации…");
    byId("indexingCount").prop("hidden", true);
    byId("indexingProgress").prop("hidden", false).addClass("indeterminate").removeAttr("aria-valuenow").find("span").css("width", "");
    byId("indexingEta").prop("hidden", false).text("Оцениваем время…");
  }

  function stopIndexingIndicator() {
    byId("pauseIndexingBtn").prop("hidden", true);
    if (!state.indexingJob || INDEXING_ACTIVE.includes(state.indexingJob.state)) byId("indexingProgress").prop("hidden", true);
  }

  async function watchIndexing(job) {
    renderIndexingJob(job);
    while (INDEXING_ACTIVE.includes(job.state)) {
      await new Promise(resolve => window.setTimeout(resolve, 750));
      try {
        const data = await requestJson("/api/indexing/status?job_id=" + encodeURIComponent(job.id), { cache: "no-store" });
        if (!data.job || data.job.id !== job.id) throw new ApiError("Состояние задачи потеряно после перезапуска сервера.");
        job = data.job;
        byId("pauseIndexingBtn").prop("disabled", false);
        renderIndexingJob(job);
      } catch (error) {
        byId("indexingEta").text("Нет связи с сервером. Проверяем состояние…");
        byId("pauseIndexingBtn").prop("disabled", true);
        // The worker continues independently of a browser/network interruption.
        if (error.message.includes("не найдена") || error.message.includes("потеряно")) throw error;
      }
    }
    if (job.state !== "completed" || !job.result) throw new ApiError("Индексация не завершена.");
    return job.result;
  }

  async function toggleIndexingPause() {
    const job = state.indexingJob;
    if (!job || !INDEXING_ACTIVE.includes(job.state)) return;
    const action = ["paused", "pause_requested"].includes(job.state) ? "resume" : "pause";
    byId("pauseIndexingBtn").prop("disabled", true);
    try {
      const data = await requestJson("/api/indexing/" + encodeURIComponent(job.id) + "/" + action, { method: "POST" });
      renderIndexingJob(data);
    } catch (error) {
      showError("Не удалось изменить состояние индексации", error, false);
    } finally { byId("pauseIndexingBtn").prop("disabled", false); }
  }

  async function restoreIndexing() {
    try {
      const data = await requestJson("/api/indexing/status", { cache: "no-store" });
      if (!data.job || state.uploading) return;
      renderIndexingJob(data.job);
      if (!INDEXING_ACTIVE.includes(data.job.state)) return;
      state.uploading = true; updateButtons();
      try {
        const result = await watchIndexing(data.job);
        if (result.errors?.length) throw new ApiError("Часть файлов не проиндексирована.", readable(result.errors));
      } finally { state.uploading = false; updateButtons(); stopIndexingIndicator(); refreshFiles({ quiet: true }); }
    } catch (error) {
      byId("indexingState").text("Не удалось получить состояние индексации");
      byId("indexingEta").prop("hidden", false).text("Проверьте соединение с сервером");
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
    startIndexingIndicator(file.name);

    const body = new FormData();
    body.append("file", file, uploadName);

    let failure = null;

    try {
      const job = await requestJson("/api/indexing/upload", {
        method: "POST",
        body
      });
      const data = await watchIndexing(job);

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
      stopIndexingIndicator();
    }

    byId("indexingState").text(failure ? "Ошибка индексации" : "Индексация завершена");
    if (failure) {
      showError("Ошибка индексации документа", failure);
    }

    await refreshFiles({ quiet: true });
  }

  function rankedSources(sources) {
    return sources.map((source, index) => ({ source, number: index + 1 }))
      .sort((a, b) => (Number.isFinite(b.source.score) ? b.source.score : -Infinity) -
        (Number.isFinite(a.source.score) ? a.source.score : -Infinity));
  }

  function renderSources(sources, target = ui.sources, prefix = "source") {
    target.empty();
    if (!sources.length) return;
    target.append(element("h4", "sources-heading").append(svgIcon("document"), document.createTextNode("Источники ответа")));
    const table = element("table", "sources-table");
    table.append($("<caption>").addClass("visually-hidden").text("Источники по убыванию релевантности"));
    const header = element("tr");
    ["№", "Документ", "Страница", "Сходство ↓", "Ссылка"].forEach(text => header.append(element("th", "", text).attr("scope", "col")));
    table.append(element("thead").append(header));
    const body = element("tbody");
    for (const { source, number } of rankedSources(sources)) {
      const row = element("tr", "source").attr({ id: prefix + "-" + number, tabindex: "-1" });
      row.append(element("td", "source-number", "[" + number + "]"));
      row.append(element("td", "source-title", source.file_name || "Документ"));
      row.append(element("td", "", Number(source.page) > 0 ? String(source.page) : "—"));
      row.append(element("td", "source-score", Number.isFinite(source.score) ? source.score.toFixed(3) : "—"));
      const linkCell = element("td");
      if (source.file) linkCell.append(element("a", "page-link", "Открыть ↗").attr({
        href: documentUrl(source.file, source.page), target: "_blank", rel: "noopener noreferrer",
        "aria-label": "Открыть " + (source.file_name || "документ") + (source.page ? ", страница " + source.page : "")
      }));
      else linkCell.text("—");
      row.append(linkCell);
      body.append(row);
    }
    table.append(body);
    target.append(element("div", "table-scroll").append(table));
  }

  function selectTurn(turnId) {
    const turn = activeDialog?.turns.find(item => item.id === turnId && item.status === "done");
    selectedTurnId = turn ? turn.id : null;
    setSidebarPanel("relevanceToggle", "relevancePanel", Boolean(turn) || state.asking);
    $(".chat-turn").removeClass("selected-turn");
    if (turn) byId("turn-" + turn.id).addClass("selected-turn");
    const chart = byId("relevanceChart").empty();
    const sources = turn?.sources || [];
    byId("sourceCount").text(sources.length);
    byId("chartCaption").text(turn ? turn.question.slice(0, 100) : "Источники выбранного ответа");
    if (!sources.length) {
      chart.append(element("p", "empty", turn ? "Для этого ответа источники не найдены." : "После ответа здесь появится сравнение источников."));
      return;
    }
    for (const { source, number } of rankedSources(sources)) {
      const value = Number.isFinite(source.score) ? source.score : null;
      const row = element("button", "relevance-row").attr({ type: "button", title: source.file_name || "Источник " + number,
        "aria-label": "Источник " + number + ": " + (source.file_name || "Документ") + ", сходство " + (value === null ? "не указано" : value.toFixed(3)) });
      row.append(element("span", "", "[" + number + "]"));
      row.append(element("span", "bar-track").attr("aria-hidden", "true").append(
        element("span", "bar-fill").css({ display: "block", width: (value === null ? 0 : Math.max(0, Math.min(1, value)) * 100) + "%" })));
      row.append(element("span", "relevance-value", value === null ? "—" : value.toFixed(3)));
      row.on("click", () => {
        byId("evidencePanel").removeClass("is-open"); byId("toolsMenuBtn").attr("aria-expanded", "false");
        highlightSourceCard(byId("source-" + turn.id + "-" + number));
      });
      chart.append(row);
    }
  }

  /* ==========================================================
     Переход к источнику и временная подсветка карточки
     ========================================================== */

  let highlightedSourceCard = null;
  let sourceHighlightTimer = null;

  function highlightSourceCard(target) {
    if (!target.length) {
      return;
    }

    window.clearTimeout(sourceHighlightTimer);

    // Убираем выделение предыдущего источника.
    if (highlightedSourceCard) {
      highlightedSourceCard.removeClass(
        "source-highlighted"
      );
    }

    highlightedSourceCard = target;

    target.addClass("source-highlighted");
    target.get(0).focus({ preventScroll: true });

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)"
    ).matches;

    target.get(0).scrollIntoView({
      behavior: reducedMotion ? "auto" : "smooth",
      block: "center"
    });

    sourceHighlightTimer = window.setTimeout(() => {
      target.removeClass("source-highlighted");

      if (highlightedSourceCard === target) {
        highlightedSourceCard = null;
      }

      sourceHighlightTimer = null;
    }, 3000);
  }


  /* ==========================================================
     Преобразование ссылок LLM [1], [2], [1, 2] в сноски
     ========================================================== */

  function decorateAnswerCitations(sources, answerTarget = ui.answer, prefix = "source") {
    const sourceCount = sources.length;

    if (!sourceCount) {
      return;
    }

    const walker = document.createTreeWalker(
      answerTarget.get(0),
      NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          const parent = node.parentElement;

          if (!parent || !node.nodeValue) {
            return NodeFilter.FILTER_REJECT;
          }

          // Не меняем код, готовые ссылки и уже обработанные сноски.
          if ($(parent).closest("a, code, pre, sup, script, style").length) {
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
      const fragment = $(document.createDocumentFragment());

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

          invalidReference.prop("title", "Этот номер отсутствует среди источников, возвращённых сервером.");

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

            link.prop("href", `#${prefix}-${number}`);

            const description = [
              source.file_name || "Документ"
            ];

            const page = Number(source.page);

            if (Number.isInteger(page) && page > 0) {
              description.push(`страница файла ${page}`);
            }

            link.prop("title", description.join(" · "));

            link.attr(
              "aria-label",
              `Перейти к источнику ${number}: ${description.join(", ")}`
            );

            link.on("click", event => {
              const target = byId(`${prefix}-${number}`);
              if (!target.length) return;
              event.preventDefault();
              selectTurn(prefix.replace(/^source-/, ""));
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

      $(textNode).replaceWith(fragment);
    }
  }

  /* ==========================================================
     Индикатор ожидания ответа
     ========================================================== */

  let answerTypingTimer = null;

  function stopAnswerTypingIndicator() {
    window.clearInterval(answerTypingTimer);
    answerTypingTimer = null;

    ui.answer.removeClass("is-generating");
    ui.answer.removeAttr("aria-busy");

    // Удаляем только индикатор, не затрагивая готовый ответ.
    const indicator = ui.answer.find(
      ".answer-typing"
    );

    if (indicator) {
      indicator.remove();
    }
  }

  function startAnswerTypingIndicator() {
    stopAnswerTypingIndicator();

    ui.answer.removeClass("is-error");
    ui.answer.addClass("is-generating");
    ui.answer.attr("aria-busy", "true");

    const indicator = element("div", "answer-typing");

    const icon = element(
      "div",
      "answer-typing-icon",
      "✦"
    );

    icon.attr("aria-hidden", "true");

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

    dots.attr("aria-hidden", "true");

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
    elapsed.attr("aria-hidden", "true");

    content.append(title, description, elapsed);
    indicator.append(icon, content);

    ui.answer.empty().append(indicator);

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

      elapsed.text(`Прошло: ${minutesText}:${secondsText}`);
    }

    answerTypingTimer = window.setInterval(
      updateElapsedTime,
      1000
    );
  }

  let dialogs = [];
  let activeDialog = null;
  let selectedTurnId = null;
  let historyDb = null;
  let historyReady = false;
  let persistenceQueue = Promise.resolve();
  const drafts = new Map();
  const HISTORY_LIMIT = 50;
  const HISTORY_AGE = 30 * 24 * 60 * 60 * 1000;

  function createId() {
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    // getRandomValues also works on HTTP installations where randomUUID is unavailable.
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  }

  function storageWarning() {
    byId("storageNotice").text("Не удалось сохранить историю в браузере. Диалог доступен до закрытия страницы.").prop("hidden", false);
  }

  function transactHistory(mode, action) {
    return new Promise((resolve, reject) => {
      const tx = historyDb.transaction("dialogs", mode);
      let result;
      action(tx.objectStore("dialogs"), value => { result = value; });
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  function persistDialogs() {
    dialogs = dialogs.filter(dialog => Date.now() - dialog.updatedAt < HISTORY_AGE)
      .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, HISTORY_LIMIT);
    const snapshot = structuredClone(dialogs);
    persistenceQueue = persistenceQueue.then(async () => {
      if (!historyDb) return;
      await transactHistory("readwrite", store => {
        store.clear();
        snapshot.forEach(dialog => store.put(dialog));
      });
    }).catch(storageWarning);
    return persistenceQueue;
  }

  function validDialog(dialog) {
    return dialog && typeof dialog.id === "string" && /^[a-zA-Z0-9-]+$/.test(dialog.id) &&
      Number.isFinite(dialog.updatedAt) && Array.isArray(dialog.turns) && dialog.turns.length &&
      dialog.turns.every(turn => turn && typeof turn.id === "string" && /^[a-zA-Z0-9-]+$/.test(turn.id) &&
        typeof turn.question === "string" && typeof turn.answer === "string" &&
        ["done", "error", "pending"].includes(turn.status) && Array.isArray(turn.sources));
  }

  async function initializeHistory() {
    try {
      historyDb = await new Promise((resolve, reject) => {
        const request = indexedDB.open("rag-md-dialogs-v1", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("dialogs", { keyPath: "id" });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error("History database is blocked"));
      });
      historyDb.onversionchange = () => { historyDb.close(); historyDb = null; storageWarning(); };
      const stored = await transactHistory("readonly", (store, done) => {
        const request = store.getAll();
        request.onsuccess = () => done(request.result);
      });
      dialogs = stored.filter(validDialog).filter(dialog => Date.now() - dialog.updatedAt < HISTORY_AGE)
        .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, HISTORY_LIMIT);
      for (const dialog of dialogs) for (const turn of dialog.turns) {
        if (turn.status === "pending") {
          turn.status = "error";
          turn.answer = "Запрос был прерван. Отправьте вопрос ещё раз.";
        }
      }
      let preferredId;
      try { preferredId = localStorage.getItem("ragmd.activeDialog.v1"); } catch { /* Optional preference. */ }
      activeDialog = preferredId === "" ? null : dialogs.find(dialog => dialog.id === preferredId) || dialogs[0] || null;
      await persistDialogs();
    } catch {
      historyDb = null;
      storageWarning();
    } finally {
      historyReady = true;
      renderConversation();
      updateButtons();
    }
  }

  function renderHistory() {
    const list = byId("historyList").empty();
    if (!dialogs.length) list.append(element("p", "empty", "Здесь появятся ваши диалоги"));
    let previousGroup = "";
    for (const dialog of [...dialogs].sort((a, b) => b.updatedAt - a.updatedAt)) {
      const date = new Date(dialog.updatedAt);
      const today = new Date();
      const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
      const group = date.toDateString() === today.toDateString() ? "Сегодня" :
        date.toDateString() === yesterday.toDateString() ? "Вчера" : date.toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
      if (group !== previousGroup) { list.append(element("p", "history-group", group)); previousGroup = group; }
      const button = element("button", "history-item").attr("type", "button")
        .toggleClass("active", activeDialog?.id === dialog.id).prop("disabled", state.asking || !historyReady);
      if (activeDialog?.id === dialog.id) button.attr("aria-current", "true");
      button.append(element("strong", "", dialog.turns[0].question));
      button.append(element("small", "", date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }) + " · Сообщений: " + dialog.turns.length * 2));
      button.on("click", () => {
        if (state.asking) return;
        if (activeDialog) drafts.set(activeDialog.id, ui.question.val());
        activeDialog = dialog;
        ui.question.val(drafts.get(dialog.id) || "");
        selectedTurnId = null;
        hideError(); renderConversation();
        byId("historySidebar").removeClass("is-open");
        byId("historyMenuBtn").attr("aria-expanded", "false");
        ui.question.trigger("focus");
      });
      list.append(button);
    }
    byId("deleteChatBtn").prop("hidden", !activeDialog);
  }

  function renderConversation() {
    try { localStorage.setItem("ragmd.activeDialog.v1", activeDialog?.id || ""); } catch { /* IndexedDB stores the conversation itself. */ }
    const stream = byId("chatStream").empty();
    const turns = activeDialog?.turns || [];
    byId("welcome").prop("hidden", turns.length > 0);
    byId("conversationTitle").text(turns[0]?.question || "Новый диалог");
    ui.answer = $(); ui.sources = $();
    turns.forEach((turn, index) => {
      const wrapper = element("section", "chat-turn").attr("id", "turn-" + turn.id);
      const user = element("article", "message user-message");
      const header = element("div", "message-header").append(element("span", "message-avatar").append(svgIcon("user")).attr("aria-hidden", "true"), element("span", "", "Вы"));
      header.append(element("time", "message-time", new Date(turn.createdAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })).attr("datetime", new Date(turn.createdAt).toISOString()));
      user.append(header, element("p", "user-question", turn.question));
      const assistant = element("article", "message assistant-message").attr("aria-label", "Ответ ассистента");
      assistant.append(element("div", "message-header").append(element("span", "message-avatar").append(svgIcon("spark")).attr("aria-hidden", "true"), element("span", "", "RAG-MD")));
      const answer = element("div", "answer").attr("aria-live", "polite");
      const sources = element("div", "sources");
      if (index === turns.length - 1) { answer.attr("id", "answer"); sources.attr("id", "sources"); ui.answer = answer; ui.sources = sources; }
      if (turn.status === "done") {
        renderMarkdown(answer, turn.answer);
        renderSources(turn.sources, sources, "source-" + turn.id);
        decorateAnswerCitations(turn.sources, answer, "source-" + turn.id);
      } else if (turn.status === "error") answer.addClass("is-error").text(turn.answer);
      assistant.append(answer);
      if (turn.status === "done") {
        const footer = element("div", "answer-footer");
        footer.append(element("span", "", "Ответ по вашей базе документов"));
        footer.append(element("button", "select-sources", "Проверить источники ↗").attr("type", "button").on("click", () => {
          selectTurn(turn.id);
          if (window.matchMedia("(max-width: 1020px)").matches) { byId("evidencePanel").addClass("is-open"); byId("toolsMenuBtn").attr("aria-expanded", "true"); }
        }));
        assistant.append(footer, sources);
        if (turn.context?.history_limited) assistant.append(element("p", "context-note", "Длинная переписка: модель получила последние сообщения в пределах окна контекста."));
      }
      wrapper.append(user, assistant); stream.append(wrapper);
    });
    renderHistory();
    selectTurn(selectedTurnId || [...turns].reverse().find(turn => turn.status === "done")?.id);
    byId("conversationScroll").scrollTop(byId("conversationScroll").prop("scrollHeight"));
  }

  function newDialog() {
    if (state.asking || !historyReady) return;
    if (activeDialog) drafts.set(activeDialog.id, ui.question.val());
    activeDialog = null; selectedTurnId = null; ui.question.val("");
    hideError(); renderConversation(); ui.question.trigger("focus");
  }

  async function askQuestion(event) {
    event.preventDefault();
    if (state.asking || state.uploading || !historyReady) return;
    const question = ui.question.val().trim();
    if (!question) { ui.question.trigger("focus"); return; }
    const history = (activeDialog?.turns || []).filter(turn => turn.status === "done").slice(-50)
      .flatMap(turn => [{ role: "user", content: turn.question.slice(0, 16000) }, { role: "assistant", content: turn.answer.slice(0, 16000) }]);
    if (!activeDialog) {
        activeDialog = { id: createId(), updatedAt: Date.now(), turns: [] };
      dialogs.unshift(activeDialog);
    }
    const turn = { id: createId(), question, answer: "", sources: [], createdAt: Date.now(), status: "pending" };
    activeDialog.turns.push(turn); activeDialog.updatedAt = Date.now();
    selectedTurnId = null;
    hideError(); state.asking = true; renderConversation(); updateButtons();
    ui.question.val("");
    persistDialogs();
    try {
      startAnswerTypingIndicator();
      const data = await requestJson("/ask", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, top_k: 8, history })
      });
      if (typeof data.answer !== "string" || !data.answer.trim()) throw new ApiError("Сервер не вернул текст ответа.");
      turn.answer = data.answer; turn.status = "done"; selectedTurnId = turn.id;
      // Keep source metadata, not document excerpts, in browser storage.
      turn.sources = (Array.isArray(data.sources) ? data.sources : []).map(source => ({
        file: source.file, file_name: source.file_name, page: source.page, score: source.score, section: source.section
      }));
      turn.context = data.context;
      drafts.delete(activeDialog.id);
    } catch (error) {
      turn.status = "error"; turn.answer = "Не удалось сформировать ответ. Повторите вопрос.";
      ui.question.val(question);
      showError("Ошибка поиска или генерации ответа", error, false);
    } finally {
      stopAnswerTypingIndicator();
      activeDialog.updatedAt = Date.now(); state.asking = false;
      renderConversation(); updateButtons(); persistDialogs(); ui.question.trigger("focus");
    }
  }

  async function reindexDatabase() {
    if (state.asking || state.uploading) return;
    state.uploading = true; state.reindexing = true; hideError(); updateButtons();
    startIndexingIndicator("Обработка документов базы");
    try {
      const job = await requestJson("/api/indexing/start", { method: "POST" });
      const data = await watchIndexing(job);
      if (!Number.isFinite(data.files) || !Number.isFinite(data.indexed_files)) throw new ApiError("Сервер не подтвердил обновление индекса.");
      byId("indexingState").text(data.errors?.length ? "Обновление завершено с ошибками" : "Индекс обновлён");
      byId("indexingFile").text("Добавлено: " + data.indexed_files + " · Уже в индексе: " + (data.skipped_files || 0));
      if (data.errors?.length) throw new ApiError("Часть файлов не проиндексирована.", readable(data.errors));
    } catch (error) {
      byId("indexingState").text("Не удалось завершить индексацию");
      showError("Ошибка индексации базы", error, false);
    } finally {
      stopIndexingIndicator(); state.uploading = false; state.reindexing = false; updateButtons();
      await refreshFiles({ quiet: true });
    }
  }

  /* Все обработчики регистрируются один раз. */
  ui.queryForm.on("submit", askQuestion);
  ui.uploadForm.on("submit", uploadDocument);
  ui.dismissErrorButton.on("click", hideError);

  ui.clearButton.on("click", newDialog);
  byId("clearHistoryBtn").on("click", async () => {
    if (state.asking || !historyReady) return;
    dialogs = []; activeDialog = null; selectedTurnId = null; drafts.clear(); ui.question.val("");
    await persistDialogs(); hideError(); renderConversation();
  });
  byId("deleteChatBtn").on("click", async () => {
    if (state.asking || !activeDialog) return;
    dialogs = dialogs.filter(dialog => dialog.id !== activeDialog.id);
    drafts.delete(activeDialog.id); activeDialog = null; selectedTurnId = null; ui.question.val("");
    await persistDialogs(); hideError(); renderConversation();
  });
  byId("reindexBtn").on("click", reindexDatabase);
  byId("pauseIndexingBtn").on("click", toggleIndexingPause);
  $("[data-question]").on("click", event => { ui.question.val($(event.currentTarget).attr("data-question")); ui.question.trigger("focus"); });
  [["historyMenuBtn", "historySidebar"], ["toolsMenuBtn", "evidencePanel"]].forEach(([button, panel]) => {
    byId(button).on("click", () => {
      const open = byId(panel).toggleClass("is-open").hasClass("is-open");
      if (open) {
        const other = panel === "historySidebar" ? "evidencePanel" : "historySidebar";
        const otherButton = panel === "historySidebar" ? "toolsMenuBtn" : "historyMenuBtn";
        byId(other).removeClass("is-open"); byId(otherButton).attr("aria-expanded", "false");
      }
      byId(button).attr("aria-expanded", String(open));
    });
  });
  $(document).on("keydown", event => {
    if (event.key === "Escape") {
      $(".is-open").removeClass("is-open");
      $("#historyMenuBtn, #toolsMenuBtn").attr("aria-expanded", "false");
    }
  });

  ui.question.on("keydown", event => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      if (!state.asking && !state.uploading) {
        ui.queryForm.get(0).requestSubmit();
      }
    }
  });

  ui.fileInput.on("change", event => {
    const files = event.currentTarget.files;

    if (!files || files.length === 0) {
      state.selectedFile = null;
      ui.selectedFile.text("");
      return;
    }

    selectFile(files[0]);
  });

  ["dragenter", "dragover"].forEach(type => {
    ui.dropZone.on(type, event => {
      event.preventDefault();

      if (!state.uploading && !state.asking) {
        ui.dropZone.addClass("dragover");
      }
    });
  });

  ui.dropZone.on("dragleave", event => {
    const related = event.relatedTarget;

    if (!(related instanceof Node) || !$.contains(ui.dropZone.get(0), related)) {
      ui.dropZone.removeClass("dragover");
    }
  });

  ui.dropZone.on("drop", event => {
    event.preventDefault();
    ui.dropZone.removeClass("dragover");

    if (state.uploading || state.asking) return;

    const files = event.originalEvent.dataTransfer?.files;

    if (!files || files.length === 0) return;

    if (files.length !== 1) {
      showError(
        "Выберите один документ",
        new ApiError("Файлы загружаются по одному.")
      );
      return;
    }

    ui.fileInput.val("");
    selectFile(files[0]);
  });

  $(window).on("beforeunload", event => {
    if (state.uploading || state.asking) {
      event.preventDefault();
      event.originalEvent.returnValue = "";
    }
  });

  window.setInterval(() => {
    if (!document.hidden && !state.uploading && !state.asking) {
      refreshFiles({ quiet: true });
    }
  }, 30000);

  $(document).on("visibilitychange", () => {
    if (!document.hidden && !state.uploading) {
      refreshFiles({ quiet: true });
    }
  });

  console.info("RAG-MD frontend:", FRONTEND_BUILD);

  updateButtons();
  refreshFiles();
  initializeHistory();
  restoreIndexing();

  /* ==========================================================
     Сворачивание блоков правой колонки
     ========================================================== */

  function setSidebarPanel(buttonId, panelId, expanded) {
    byId(buttonId).attr("aria-expanded", String(expanded));
    byId(panelId).prop("hidden", !expanded);
  }

  function initializeSidebarPanels() {
    [
      ["filesToggle", "filesPanel", true],
      ["uploadToggle", "uploadPanel", false],
      ["relevanceToggle", "relevancePanel", false]
    ].forEach(([buttonId, panelId, defaultExpanded]) => {
      setSidebarPanel(buttonId, panelId, defaultExpanded);
      byId(buttonId).on("click", () => {
        setSidebarPanel(buttonId, panelId, byId(buttonId).attr("aria-expanded") !== "true");
      });
    });
  }

  initializeSidebarPanels();
  initializeDocumentFileSearch();
  initializeFileListResize();
  refreshIndexSummary();
  window.setInterval(() => { if (!document.hidden) refreshIndexSummary(); }, 10000);
});
