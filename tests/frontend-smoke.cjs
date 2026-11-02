/* Run with Node.js and a Chromium browser. Set CHROME_PATH if needed. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const candidates = [process.env.CHROME_PATH,
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"];
const chrome = candidates.find(candidate => candidate && fs.existsSync(candidate));
assert(chrome, "Set CHROME_PATH to a Chromium browser executable");

const files = [
  { name: "Насос.pdf", relative_path: "Нормы/Насос.pdf", size_mb: 1, mtime: 1700000000 },
  { name: "Инструкция.txt", relative_path: "Нормы/Архив/Инструкция.txt", size_mb: 0.1 },
  { name: '<img src=x onerror="window.injected=1">.md', size_mb: 0.01 }
];
const source = { score: 0.83, file_name: "Насос.pdf", file: "Нормы/Насос.pdf", page: 7, section: "2.1" };
const answer = '# Требования\n\n**Проверка** [1, 1] и [9].\n\n- Осмотр\n- Испытание\n\n3. Запись\n\n> Примечание\n\n`[1]`\n\n```\n[1] <script>window.injected=1</script>\n```\n\n<img src=x onerror="window.injected=1">';
let uploadCount = 0;
let apiFailures = [];
let askPayloads = [];
let indexJob = null, indexResult = null, jobSequence = 0, resumed = false;
function launchJob(result, kind) {
  indexResult = result; resumed = false;
  indexJob = { id: "test-job-" + ++jobSequence, kind, state: "running",
    total_files: kind === "base" ? 3 : 1, completed_files: kind === "base" ? 1 : 0,
    current_file: "Насос.pdf", stage: "embedding", stage_done: 1, stage_total: 4,
    elapsed_seconds: 10, estimated_remaining_seconds: 25, result: null };
  return indexJob;
}

// These assertions execute in Chromium against the real UI and real jQuery XHR.
async function browserChecks() {
  const $ = window.jQuery;
  const results = [];
  function check(value, message) {
    if (!value) throw new Error(message);
    results.push(message);
  }
  async function until(predicate, message) {
    for (let attempt = 0; attempt < 500; attempt++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(message);
  }
  async function ask(question, shortcut = false) {
    $("#question").val(question);
    if (shortcut) $("#question").trigger($.Event("keydown", { key: "Enter", ctrlKey: true }));
    else document.querySelector("#queryForm").requestSubmit();
    check($("#askBtn").prop("disabled") && $("#answer").attr("aria-busy") === "true", "query busy state: " + question);
    check(!$("#relevancePanel").prop("hidden") && $("#relevanceToggle").attr("aria-expanded") === "true", "relevance opens during generation: " + question);
    await until(() => !$("#askBtn").prop("disabled"), "query did not finish: " + question);
    check(!$("#answer .answer-typing").length && !$("#answer").attr("aria-busy"), "query indicator cleanup: " + question);
  }
  async function upload(name, useInput = false) {
    const transfer = new DataTransfer();
    transfer.items.add(new File(["sample text"], name, { type: "text/plain" }));
    if (useInput) {
      document.querySelector("#file").files = transfer.files;
      $("#file").trigger("change");
    } else {
      document.querySelector("#dropZone").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }
    check($("#selectedFile").text().includes(name), "file selected: " + name);
    document.querySelector("#uploadForm").requestSubmit();
    check(!$("#indexingProgress").prop("hidden") && !$(".container").prop("inert"), "inline indexing state: " + name);
    await until(() => !$("#uploadBtn").prop("disabled"), "upload did not finish: " + name);
    check($("#indexingProgress").attr("aria-valuenow") === "100" && $("#pauseIndexingBtn").prop("hidden"), "completed indexing progress: " + name);
  }
  try {
    await until(() => $("#collectionBadge").text() === "Документов: 3", "initial files did not load");

    await until(() => !$("#askBtn").prop("disabled"), "history not initialized");
    if (sessionStorage.getItem("dialogue-reload")) {
      sessionStorage.removeItem("dialogue-reload");
      check($("#fileList").height() === 320, "file list height restored after reload");
      check($(".chat-turn").length === 2 && $("#conversationTitle").text() === "Тест контекста", "dialogue restored after reload");
      check($("#relevanceChart .relevance-row").length === 1, "source metadata restored");
      await ask("Продолжение после перезагрузки");
      let requests = await (await fetch("/test-requests")).json();
      let last = requests.at(-1);
      check(last.history.length === 4 && last.history[0].content === "Тест контекста" && last.history[2].content === "А какие сроки?", "restored questions sent as context");
      check(last.history[1].role === "assistant" && last.history[1].content.includes("Требования"), "previous answers sent to model");
      check($(".chat-turn").length === 3, "continuing appends messages");
      const firstCitation = $(".chat-turn").first().find(".answer-citation");
      const latestCitation = $(".chat-turn").last().find(".answer-citation");
      check(firstCitation.attr("href") !== latestCitation.attr("href"), "citations scoped per answer");
      firstCitation.trigger("click");
      check(document.activeElement.id === firstCitation.attr("href").slice(1), "old citations open old sources");
      $(".chat-turn").first().find(".select-sources").trigger("click");
      check($("#chartCaption").text() === "Тест контекста", "chart follows selected answer");
      $("#clearBtn").trigger("click");
      const randomUUID = crypto.randomUUID;
      crypto.randomUUID = undefined;
      await ask("Отдельный диалог");
      crypto.randomUUID = randomUUID;
      requests = await (await fetch("/test-requests")).json();
      check(requests.at(-1).history.length === 0, "new dialogue has no previous context");
      $(".history-item").filter((i, node) => node.textContent.includes("Тест контекста")).trigger("click");
      check($(".chat-turn").length === 3, "saved conversation can be reopened");
      await ask("Уточнение после переключения");
      requests = await (await fetch("/test-requests")).json();
      check(requests.at(-1).history.length === 6 && !JSON.stringify(requests.at(-1).history).includes("Отдельный диалог"), "conversation context stays isolated");
      $("#deleteChatBtn").trigger("click");
      await until(() => !$(".chat-turn").length, "current dialogue deletion failed");
      check($(".history-item").length >= 1, "deleting dialogue preserves others");
      $("#clearHistoryBtn").trigger("click");
      await until(() => !$(".history-item").length, "history clear failed");
      await ask("Какие документы нужны для приёмки оборудования?");
      document.dispatchEvent(new Event("visibilitychange"));
      await until(() => $("#fileList").text().includes("Паспорт оборудования.pdf"), "preview file list did not refresh");
      $("#fileList .folder-toggle").each((i, node) => { if (node.getAttribute("aria-expanded") !== "true") node.click(); });
      await fetch("/test-result", { method: "POST", body: JSON.stringify({ ok: true, results: JSON.parse(sessionStorage.getItem("previous-checks") || "[]").concat(results) }) });
      return;
    }

    check($(".evidence-heading use").attr("href").endsWith("#inspection") && $("#indexingTitle").prev().find("use").attr("href").endsWith("#database"), "mockup outline icons");
    check($("#dropZone .upload-icon use").attr("href").endsWith("#cloud"), "cloud upload matches mockup");
    await until(() => $("#indexingSummaryValue").text() === "2 / 3", "index summary did not load");
    check($("#indexingSummaryHint").text() === "проиндексировано / всего документов", "persistent index summary labels");
    const listHeight = $("#fileList").height();
    $("#filesResizeHandle").trigger($.Event("keydown", { key: "ArrowDown" }));
    check($("#fileList").height() === listHeight + 40 && localStorage.getItem("ragmd.fileListHeight.v1") === String(listHeight + 40), "file list resizes and saves height");
    $("#filesToggle").trigger("click"); $("#filesToggle").trigger("click");
    check($("#fileList").height() === listHeight + 40, "file list height survives collapse");
    check($.fn.jquery === "4.0.0", "local jQuery version");
    check(!$("#filesPanel").prop("hidden") && $("#uploadPanel").prop("hidden") && $("#uploadToggle").attr("aria-expanded") === "false", "uploads collapsed by default");
    check($("#relevancePanel").prop("hidden") && $("#relevanceToggle").attr("aria-expanded") === "false", "relevance collapsed before first question");
    $("#filesToggle").trigger("click"); $("#filesToggle").trigger("click");
    check(!$("#filesPanel").prop("hidden") && $("#filesToggle").attr("aria-expanded") === "true", "sidebar toggle");
    const folder = $(".folder-toggle").filter((i, node) => node.title === "Нормы");
    folder.trigger("click");
    check(folder.attr("aria-expanded") === "true" && !$("#" + folder.attr("aria-controls")).prop("hidden"), "folder expansion");
    $("#fileSearch").val("нормы насос").trigger("input");
    await until(() => $("#fileList .file-item").length === 1, "debounced search failed");
    check($("#fileSearchStatus").text() === "Найдено документов: 1 из 3", "search count");
    check($("#fileList .folder-toggle").attr("aria-expanded") === "true", "search expands folders");
    $("#fileSearch").val("нет такого файла").trigger($.Event("keydown", { key: "Enter" }));
    check(!$("#fileList .file-item").length && $("#fileList").text().includes("не найдены"), "empty search");
    $("#clearFileSearch").trigger("click");
    check($("#fileList .file-item").length === 3, "clear search");
    check($(".folder-toggle").filter((i, node) => node.title === "Нормы").attr("aria-expanded") === "true", "folder expansion preserved");
    check(!$("#fileList img").length && !window.injected, "file names rendered as text");

    await ask("formatted", true);
    check(!$("#relevancePanel").prop("hidden"), "relevance remains open with answer");
    $("#relevanceToggle").trigger("click");
    check($("#relevancePanel").prop("hidden"), "relevance manually collapses");
    $("#relevanceToggle").trigger("click");
    check(!$("#relevancePanel").prop("hidden") && $("#relevanceChart .relevance-row").length, "relevance manually expands with sources");
    check($("#answer h3").text() === "Требования", "Markdown heading");
    check($("#answer ul li").length === 2 && $("#answer ol").prop("start") === 3, "Markdown lists");
    check($("#answer blockquote").text() === "Примечание", "Markdown quote");
    check($("#answer .answer-citation").length === 1 && $("#answer .citation-unresolved").text() === "[9]", "validated citations");
    check($("#answer code .answer-citation").length === 0, "code citations untouched");
    check(!$("#answer img, #answer script").length && !window.injected, "answer HTML escaped");
    check($("#sources .page-link").attr("href") === "/api/document/%D0%9D%D0%BE%D1%80%D0%BC%D1%8B/%D0%9D%D0%B0%D1%81%D0%BE%D1%81.pdf#page=7", "encoded PDF page link");
    $(".answer-citation").trigger("click");
    check($("#sources .source").first().hasClass("source-highlighted") && document.activeElement.id === $("#sources .source").first().attr("id"), "citation focus and highlight");
    $("#clearBtn").trigger("click");
    check(!$("#question").val() && !$("#sources").children().length, "clear answer");
    check($("#relevancePanel").prop("hidden"), "new dialogue collapses relevance");

    for (const [question, expected] of [
      ["http-json", "Требуется вход"], ["http-html", "HTTP 502"],
      ["invalid-json", "не в формате JSON"], ["scalar-json", "Неожиданный формат"],
      ["network", "Не удалось связаться"]
    ]) {
      await ask(question);
      check(!$("#errorPanel").prop("hidden") && $("#errorMessage").text().includes(expected), "error display: " + question);
      check($("#answer").hasClass("is-error"), "answer error state: " + question);
      $("#dismissErrorBtn").trigger("click");
      check($("#errorPanel").prop("hidden"), "dismiss error: " + question);
    }
    await ask("formatted");
    check(!$("#answer").hasClass("is-error"), "recovery after query failure");


    $("#uploadToggle").trigger("click");
    check(!$("#uploadPanel").prop("hidden"), "upload expands manually");
    await upload("indexed.txt", true);
    check($("#uploadStatus").hasClass("ok") && $("#uploadStatus").text().includes("Фрагментов: 2"), "multipart upload indexed");
    await upload("skipped.md");
    check($("#uploadStatus").text().includes("уже проиндексирован"), "duplicate upload");
    await upload("empty.txt");
    check($("#errorMessage").text().includes("извлечь текст"), "empty document error");
    await upload("failed.txt");
    check($("#errorMessage").text().includes("Ошибка индексации"), "indexing error");
    const invalid = new DataTransfer();
    invalid.items.add(new File(["x"], "invalid.exe"));
    document.querySelector("#dropZone").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: invalid }));
    check($("#errorMessage").text().includes("Неподдерживаемое расширение") && !$("#selectedFile").text(), "invalid extension rejected");
    const multiple = new DataTransfer();
    multiple.items.add(new File(["x"], "one.txt"));
    multiple.items.add(new File(["x"], "two.txt"));
    document.querySelector("#dropZone").dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: multiple }));
    check($("#errorMessage").text().includes("по одному"), "multiple file drop rejected");

    $("#reindexBtn").trigger("click");
    await until(() => !$("#pauseIndexingBtn").prop("hidden"), "pause button missing");
    check($("#indexingEta").text().includes("≈"), "estimated remaining time displayed");
    $("#pauseIndexingBtn").trigger("click");
    await until(() => $("#indexingState").text() === "Индексация на паузе", "pause acknowledgement missing");
    check($("#pauseIndexingBtn").text() === "Продолжить", "pause changes to resume");
    check($("#indexingEta").text().includes("снятия паузы"), "paused ETA is suspended");
    check($("#pauseIndexingBtn use").attr("href").endsWith("#play"), "resume uses outline play icon");
    $("#pauseIndexingBtn").trigger("click");
    await until(() => !$("#reindexBtn").prop("disabled"), "reindex did not finish");
    check($("#indexingState").text() === "Индекс обновлён", "reindex result confirmed");
    await ask("ranking");
    check($("#sources .source").first().find(".source-number").text() === "[2]", "sources sorted by score without renumbering citations");
    check($("#relevanceChart .relevance-row").first().text().includes("[2]"), "chart uses same descending ranking");
    check($("#relevanceChart").text().includes("0.950") && !$("#relevanceChart").text().includes("%"), "raw similarity is not a probability");
    $("#clearBtn").trigger("click");
    await ask("Тест контекста");
    await ask("А какие сроки?");
    check($(".chat-turn").length === 2 && $(".history-item.active").length === 1, "follow-up stays in the same dialogue");
    const requests = await (await fetch("/test-requests")).json();
    const previous = requests.at(-1);
    check(previous.history.length === 2 && previous.history[0].content === "Тест контекста", "follow-up request includes prior question");
    await new Promise((resolve, reject) => {
      const request = indexedDB.open("rag-md-dialogs-v1", 1);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("dialogs", "readonly");
        const get = tx.objectStore("dialogs").getAll();
        get.onsuccess = () => {
          if (!get.result.some(dialog => dialog.turns.length === 2 && dialog.turns[0].question === "Тест контекста")) reject(new Error("Dialogue not persisted"));
        };
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = reject;
      };
      request.onerror = reject;
    });
    sessionStorage.setItem("previous-checks", JSON.stringify(results));
    sessionStorage.setItem("dialogue-reload", "1");
    location.reload();

  } catch (error) {
    await fetch("/test-result", { method: "POST", body: JSON.stringify({ ok: false, error: error.stack, results }) });
  }
}


async function captureScreenshots(browserLog) {
  const match = browserLog.match(/DevTools listening on (ws:\/\/[^\s]+)/);
  assert(match, "DevTools endpoint missing");
  const endpoint = new URL(match[1]);
  const tabs = await (await fetch("http://" + endpoint.host + "/json/list")).json();
  const tab = tabs.find(item => item.type === "page" && item.url.startsWith("http://127.0.0.1:"));
  assert(tab, "Browser page missing");
  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;
  socket.addEventListener("message", event => {
    const result = JSON.parse(event.data);
    if (!pending.has(result.id)) return;
    const { resolve, reject } = pending.get(result.id);
    pending.delete(result.id);
    if (result.error) reject(new Error(JSON.stringify(result.error)));
    else resolve(result.result);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  const call = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const output = path.join(root, "output", "interface-concepts", "implemented");
  fs.mkdirSync(output, { recursive: true });
  try {
    for (const [name, width, height] of [["desktop", 1536, 1024], ["mobile", 390, 844]]) {
      await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      if (name === "desktop") {
        const handle = await evaluate('(() => { const n=document.querySelector("#filesResizeHandle"); n.scrollIntoView({block:"center"}); const r=n.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2,height:document.querySelector("#fileList").getBoundingClientRect().height}; })()');
        await call("Input.dispatchMouseEvent", {type:"mouseMoved",x:handle.x,y:handle.y});
        await call("Input.dispatchMouseEvent", {type:"mousePressed",x:handle.x,y:handle.y,button:"left",clickCount:1});
        await call("Input.dispatchMouseEvent", {type:"mouseMoved",x:handle.x,y:handle.y+80,button:"left",buttons:1});
        await call("Input.dispatchMouseEvent", {type:"mouseReleased",x:handle.x,y:handle.y+80,button:"left",clickCount:1});
        const height=await evaluate('document.querySelector("#fileList").getBoundingClientRect().height');
        assert(height >= handle.height+60, "file list does not resize with pointer drag");
        await evaluate('document.querySelector("#evidencePanel").scrollTop=0');
      }
      const dimensions = await evaluate("({width: innerWidth, scrollWidth: document.documentElement.scrollWidth})");
      assert(dimensions.scrollWidth <= dimensions.width, name + ": page overflows horizontally");
      const screenshot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      fs.writeFileSync(path.join(output, name + ".png"), Buffer.from(screenshot.data, "base64"));
      if (name === "desktop") {
        await evaluate("(async () => {\n document.querySelector(\"#reindexBtn\").click();\n for (let i=0;i<100 && document.querySelector(\"#pauseIndexingBtn\").hidden;i++) await new Promise(r=>setTimeout(r,30));\n document.querySelector(\".indexing-card\").scrollIntoView({block:\"center\"});\n})()");
        const clip = await evaluate('(() => { const r=document.querySelector(".indexing-card").getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1}; })()');
        const running = await call("Page.captureScreenshot", { format: "png", clip });
        fs.writeFileSync(path.join(output, "indexing-running.png"), Buffer.from(running.data, "base64"));
        await evaluate("(async () => {\n document.querySelector(\"#pauseIndexingBtn\").click();\n for(let i=0;i<100 && document.querySelector(\"#indexingState\").textContent!==\"Индексация на паузе\";i++) await new Promise(r=>setTimeout(r,30));\n})()");
        const paused = await call("Page.captureScreenshot", { format: "png", clip });
        fs.writeFileSync(path.join(output, "indexing-paused.png"), Buffer.from(paused.data, "base64"));
        await evaluate("(async () => {\n document.querySelector(\"#pauseIndexingBtn\").click();\n for(let i=0;i<100 && document.querySelector(\"#reindexBtn\").disabled;i++) await new Promise(r=>setTimeout(r,30));\n document.querySelector(\"#evidencePanel\").scrollTop=0;\n})()");
      }
    }
    await evaluate("document.querySelector('#toolsMenuBtn').click()");
    const screenshot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    fs.writeFileSync(path.join(output, "mobile-tools.png"), Buffer.from(screenshot.data, "base64"));
    console.log("Screenshots saved to " + output);
  } finally { socket.close(); }
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "rag-md-smoke-"));
  let child;
  let finish;
  const completed = new Promise(resolve => { finish = resolve; });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const reply = (status, value, type = "application/json") => {
      res.writeHead(status, { "Content-Type": type });
      res.end(type === "application/json" ? JSON.stringify(value) : value);
    };
    let body = "";
    for await (const part of req) body += part;
    if (url.pathname === "/test-result") {
      reply(200, {});
      finish(JSON.parse(body));
    } else if (url.pathname === "/test-requests") {
      reply(200, askPayloads);
    } else if (url.pathname === "/api/files") {
      reply(200, { files });
    } else if (url.pathname === "/ask") {
      try {
        assert.equal(req.headers["content-type"], "application/json");
        const data = JSON.parse(body);
        assert.equal(data.top_k, 8);
        assert(Array.isArray(data.history));
        askPayloads.push(data);
        if (data.question === "http-json") reply(401, { detail: "Требуется вход" });
        else if (data.question === "http-html") reply(502, "<h1>Bad gateway</h1>", "text/html");
        else if (data.question === "invalid-json") reply(200, "not json", "text/plain");
        else if (data.question === "scalar-json") reply(200, 42);
        else if (data.question === "network") req.socket.destroy();
        else if (data.question === "ranking") reply(200, { answer, sources: [source, { ...source, score: 0.95, file_name: "Второй.pdf" }, { ...source, score: 0.6 }] });
        else if (data.question === "Какие документы нужны для приёмки оборудования?") {
          files.splice(0, files.length,
            { name: "Паспорт оборудования.pdf", relative_path: "Оборудование/Паспорт оборудования.pdf", size_mb: 1.2, mtime: 1793433600 },
            { name: "Протокол испытаний.pdf", relative_path: "Оборудование/Протокол испытаний.pdf", size_mb: 0.6, mtime: 1793433600 },
            { name: "Руководство по эксплуатации.pdf", relative_path: "Оборудование/Руководство по эксплуатации.pdf", size_mb: 2.4, mtime: 1793433600 });
          reply(200, {
          answer: "Состав документов зависит от типа оборудования и условий договора. Для приёмки проверьте:\n\n1. Паспорт оборудования и сведения о комплектности [1].\n2. Протокол проведённых испытаний [2].\n3. Комплект эксплуатационной документации [3].\n\nДля уточнения требований укажите тип оборудования и условия поставки.",
          sources: [
            { file_name: "Паспорт оборудования.pdf", file: "Оборудование/Паспорт оборудования.pdf", page: 12, score: 0.94 },
            { file_name: "Протокол испытаний.pdf", file: "Оборудование/Протокол испытаний.pdf", page: 8, score: 0.87 },
            { file_name: "Руководство по эксплуатации.pdf", file: "Оборудование/Руководство по эксплуатации.pdf", page: 24, score: 0.76 }
          ]
        });
        }
        else reply(200, { answer, sources: [source], context: { messages_used: data.history.length, history_limited: false } });
      } catch (error) { apiFailures.push(error.message); reply(500, { detail: error.message }); }
    } else if (url.pathname === "/api/indexing/summary") {
      reply(200, {indexed_documents: 2, total_documents: files.length});
    } else if (url.pathname === "/api/indexing/status") {
      if (indexJob && !["paused", "pause_requested"].includes(indexJob.state) && (indexJob.kind !== "base" || resumed)) {
        indexJob = { ...indexJob, state: "completed", completed_files: indexJob.total_files, estimated_remaining_seconds: 0, result: indexResult };
      }
      if (indexJob?.state === "pause_requested") indexJob.state = "paused";
      reply(200, { job: indexJob });
    } else if (url.pathname === "/api/indexing/start") {
      reply(202, launchJob({ files: 3, indexed_files: 1, skipped_files: 2, chunks: 2, errors: [] }, "base"));
    } else if (/^\/api\/indexing\/[^/]+\/(pause|resume)$/.test(url.pathname)) {
      if (url.pathname.endsWith("/pause")) indexJob.state = "paused";
      else { resumed = true; indexJob.state = "running"; }
      reply(200, indexJob);
    } else if (url.pathname === "/api/indexing/upload") {
      try {
        uploadCount++;
        assert.match(req.headers["content-type"], /^multipart\/form-data; boundary=/);
        assert.match(body, /name="file"; filename="/);
        assert.match(body, /sample text/);
        let result;
        if (body.includes('filename="empty.txt"')) result = { status: "empty" };
        else if (body.includes('filename="failed.txt"')) result = { errors: ["OCR failed"] };
        else if (body.includes('filename="skipped.md"')) result = { status: "skipped" };
        else result = { status: "indexed", chunks: 2 };
        reply(202, launchJob(result, "upload"));
      } catch (error) { apiFailures.push(error.message); reply(500, { detail: error.message }); }
    } else if (url.pathname.startsWith("/assets/")) {
      const asset = path.resolve(root, "frontend", "." + url.pathname);
      if (!asset.startsWith(path.join(root, "frontend", "assets") + path.sep)) return reply(404, {});
      const type = asset.endsWith(".css") ? "text/css" : asset.endsWith(".svg") ? "image/svg+xml" : "text/javascript";
      reply(200, fs.readFileSync(asset), type);
    } else {
      const entry = process.env.FRONTEND_ENTRY === "php" ? "frontend/index.php" : "app/static/index.html";
      const html = fs.readFileSync(path.join(root, entry), "utf8")
        .replace(/^<\?php[\s\S]*?\?>\s*/, "")
        .replace(/<\?= \$(css|js)Version \?>/g, "test")
        .replace("</body>", `<script>document.addEventListener("DOMContentLoaded", function () { jQuery(function () { (${browserChecks.toString()})(); }); });</script></body>`);
      reply(200, html, "text/html; charset=utf-8");
    }
  });
  try {
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    child = spawn(chrome, ["--headless=new", "--remote-debugging-port=0", "--window-size=1536,1024", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
      "--disable-background-networking", `--user-data-dir=${profile}`, `http://127.0.0.1:${server.address().port}`],
    { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let browserLog = "";
    child.stderr.on("data", data => { browserLog = (browserLog + data).slice(-4000); });
    child.on("error", error => finish({ ok: false, error: error.message }));
    const timeout = setTimeout(() => finish({ ok: false, error: "Browser checks timed out", browserLog }), 45000);
    const result = await completed;
    clearTimeout(timeout);
    if (result.ok) console.log(`Passed ${result.results.length} browser checks (${process.env.FRONTEND_ENTRY || "static"} entry).`);
    else console.log(JSON.stringify(result, null, 2));
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(apiFailures, []);
    assert.equal(uploadCount, 4);
    if (process.env.UI_SCREENSHOTS === "1") await captureScreenshots(browserLog);
  } finally {
    if (child && child.exitCode === null) {
      const exited = new Promise(resolve => child.once("exit", resolve));
      child.kill();
      await exited;
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    // Only this run's own temporary browser profile is removed.
    assert.equal(path.dirname(path.resolve(profile)), path.resolve(os.tmpdir()));
    assert(path.basename(profile).startsWith("rag-md-smoke-"));
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
