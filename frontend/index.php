<?php
declare(strict_types=1);

header('Content-Type: text/html; charset=utf-8');
header('Cache-Control: no-store, max-age=0');

$cssPath = __DIR__ . '/assets/css/styles.css';
$jsPath = __DIR__ . '/assets/js/app.js';

$cssVersion = is_file($cssPath) ? (string) filemtime($cssPath) : '1';
$jsVersion = is_file($jsPath) ? (string) filemtime($jsPath) : '1';
?>
<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#f97316">
<title>RAG-MD — поиск по нормативной базе</title>

<link rel="stylesheet" href="/assets/css/styles.css?v=<?= $cssVersion ?>">
</head>

<body>
<div class="container">
  <header class="header">
    <div class="brand">
      <div class="logo" aria-hidden="true">📚</div>
      <div>
        <h1>RAG-MD</h1>
        <p class="subtitle">Поиск и анализ нормативной документации</p>
      </div>
    </div>
  </header>

  <div class="layout">
    <main class="left-column">
      <section class="card" aria-labelledby="queryTitle">
        <h2 id="queryTitle">Входные данные</h2>

        <form id="queryForm">
          <label for="question">Запрос</label>
          <textarea
            id="question"
            placeholder="Например: какие требования предъявляются к испытаниям центробежных насосов после ремонта?"
            required
          ></textarea>

          <div class="row">
            <button class="primary" id="askBtn" type="submit">
              Найти и сформировать ответ
            </button>
            <button class="secondary" id="clearBtn" type="button">
              Очистить
            </button>
          </div>

          <p class="hint">Ctrl + Enter — отправить запрос</p>
        </form>
      </section>

      <section class="card" aria-labelledby="answerTitle">
        <h2 id="answerTitle">Ответ и источники</h2>
        <div class="answer" id="answer" aria-live="polite">
          <p>Задайте вопрос по нормативной базе. Здесь появится ответ и найденные фрагменты документов.</p>
        </div>
        <div class="sources" id="sources"></div>
      </section>

      <section
        class="card error-panel"
        id="errorPanel"
        aria-labelledby="errorTitle"
        hidden
      >
        <h2 id="errorTitle">Ошибка</h2>
        <p id="errorMessage" role="alert"></p>

        <details id="errorDetailsBlock" hidden>
          <summary>Технические подробности</summary>
          <pre class="error-details" id="errorDetails"></pre>
        </details>

        <div class="row">
          <button class="secondary" id="dismissErrorBtn" type="button">
            Скрыть сообщение
          </button>
        </div>
      </section>
    </main>

<aside class="right-column" aria-label="Документы и загрузка">

  <!-- База файлов: по умолчанию свёрнута -->
  <section
    class="card collapsible-card"
    aria-labelledby="filesTitle"
  >
    <h2 class="collapse-heading" id="filesTitle">
      <button
        class="collapse-toggle"
        id="filesToggle"
        type="button"
        aria-expanded="false"
        aria-controls="filesPanel"
      >
        <span class="collapse-label">База файлов</span>

        <span class="collapse-actions">
          <span
            class="badge"
            id="collectionBadge"
            aria-live="polite"
          >
            Документов: …
          </span>

          <span class="collapse-chevron" aria-hidden="true"></span>
        </span>
      </button>
    </h2>

    <div
      class="collapse-panel"
      id="filesPanel"
      role="region"
      aria-labelledby="filesTitle"
      hidden
    >

	<div class="file-search">
  <label class="visually-hidden" for="fileSearch">
    Поиск по именам файлов и папкам
  </label>

  <div class="file-search-control">
    <span class="file-search-icon" aria-hidden="true">⌕</span>

    <input
      id="fileSearch"
      type="search"
      placeholder="Найти файл или папку…"
      autocomplete="off"
      spellcheck="false"
      aria-controls="fileList"
      aria-describedby="fileSearchStatus"
    >

    <button
      id="clearFileSearch"
      class="file-search-clear"
      type="button"
      aria-label="Очистить поиск файлов"
      title="Очистить поиск"
      hidden
    >
      ×
    </button>
  </div>

  <p
    id="fileSearchStatus"
    class="file-search-status"
    role="status"
    aria-live="polite"
    hidden
  ></p>
</div>

      <div
        class="file-list"
        id="fileList"
        aria-label="Список документов"
      >
        <p class="empty">Загрузка списка…</p>
      </div>
    </div>
  </section>

  <!-- Загрузка документа: по умолчанию свёрнута -->
  <section
    class="card collapsible-card"
    aria-labelledby="uploadTitle"
  >
    <h2 class="collapse-heading" id="uploadTitle">
      <button
        class="collapse-toggle"
        id="uploadToggle"
        type="button"
        aria-expanded="false"
        aria-controls="uploadPanel"
      >
        <span class="collapse-label">Загрузка документа</span>

        <span class="collapse-actions">
          <span class="collapse-chevron" aria-hidden="true"></span>
        </span>
      </button>
    </h2>

    <div
      class="collapse-panel"
      id="uploadPanel"
      role="region"
      aria-labelledby="uploadTitle"
      hidden
    >
      <form id="uploadForm">
        <div class="upload-zone" id="dropZone">
          <label for="file">
            Выберите PDF, DjVu, TXT или MD
          </label>

          <input
            id="file"
            type="file"
            accept=".pdf,.djvu,.djv,.txt,.md"
            aria-describedby="uploadHint selectedFile"
          >

          <p class="hint" id="uploadHint">
            Можно перетащить один файл в эту область
          </p>

          <div
            class="selected-file"
            id="selectedFile"
            aria-live="polite"
          ></div>
        </div>

        <div class="row">
          <button
            class="primary full-width"
            id="uploadBtn"
            type="submit"
          >
            Загрузить и проиндексировать
          </button>
        </div>
      </form>

      <p
        class="status"
        id="uploadStatus"
        role="status"
        aria-live="polite"
      ></p>
    </div>
  </section>

</aside>
  </div>

  <footer class="footer">
    2026, RAG-MD ver.0.4a, all rights reserved.
    contacts —
    <a href="mailto:xander89ab@gmail.com">xander89ab@gmail.com</a>
  </footer>
</div>

<div class="modal-overlay" id="indexingOverlay" hidden>
  <section
    class="modal"
    id="indexingModal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="indexingTitle"
    aria-describedby="indexingDescription"
    tabindex="-1"
  >
    <div class="hourglass" aria-hidden="true">⌛</div>
    <h2 id="indexingTitle">Индексация документа</h2>
    <p class="modal-file" id="indexingFile"></p>

    <p class="modal-description" id="indexingDescription">
      Файл передаётся на сервер и обрабатывается.
      Дождитесь завершения и не закрывайте страницу.
    </p>

    <div class="elapsed" id="elapsedTime">Прошло: 00:00</div>

    <p class="hint">
      Время обработки зависит от объёма документа
      и производительности сервера.
    </p>
  </section>
</div>

<script src="/assets/js/app.js?v=<?= $jsVersion ?>" defer></script>
</body>
</html>