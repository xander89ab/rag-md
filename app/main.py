import logging
import os
import uuid
from pathlib import Path
from typing import Literal

import torch
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, model_validator, field_validator
from sentence_transformers import SentenceTransformer

from starlette.concurrency import run_in_threadpool

from .indexing import IndexingManager, IndexingBusy
from .documents import document_files, IndexSummary
from .rag import generate_answer, search, rewrite_search_query, trim_history, history_budget

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)

logger = logging.getLogger("rag-md")

app = FastAPI(
    title="RAG-MD",
    description="Поиск и анализ нормативной документации",
    version="0.1.2",
)

QDRANT_URL = os.getenv("QDRANT_URL", "http://qdrant:6333")
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://ollama:11434")
EMBED_MODEL = os.getenv(
    "EMBED_MODEL",
    "intfloat/multilingual-e5-small",
)
LLM_MODEL = os.getenv("LLM_MODEL", "qwen3.5:9b-q4_K_M")
COLLECTION = os.getenv("COLLECTION", "normative_docs")
DOCS_DIR = Path(os.getenv("DOCS_DIR", "/data/docs")).resolve()
PROCESSED_DIR = Path(
    os.getenv("PROCESSED_DIR", "/data/processed")
).resolve()
EMBED_BATCH_SIZE = int(os.getenv("EMBED_BATCH_SIZE", "8"))
TORCH_THREADS = int(os.getenv("TORCH_THREADS", "4"))

ALLOWED_EXTENSIONS = {
    ".pdf",
    ".djvu",
    ".djv",
    ".txt",
    ".md",
}

DOCS_DIR.mkdir(parents=True, exist_ok=True)
PROCESSED_DIR.mkdir(parents=True, exist_ok=True)

torch.set_num_threads(TORCH_THREADS)

logger.info("Загрузка модели эмбеддингов: %s", EMBED_MODEL)
embedder = SentenceTransformer(EMBED_MODEL)
indexing_manager = IndexingManager()
index_summary = IndexSummary()


class ConversationMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1, max_length=16000)


class AskRequest(BaseModel):
    question: str = Field(max_length=2000)
    top_k: int = Field(default=8, ge=1, le=12)
    history: list[ConversationMessage] = Field(default_factory=list, max_length=100)

    @field_validator("question")
    @classmethod
    def validate_question_size(cls, value):
        if len(value.encode("utf-8")) > 4000:
            raise ValueError("Сократите вопрос до 4000 байт UTF-8")
        return value

    @model_validator(mode="after")
    def validate_history(self):
        if len(self.history) % 2 or any(
            message.role != ("user" if i % 2 == 0 else "assistant")
            for i, message in enumerate(self.history)
        ):
            raise ValueError("История должна содержать пары вопрос–ответ")
        return self


@app.exception_handler(HTTPException)
async def http_exception_handler(
    request: Request,
    exc: HTTPException,
) -> JSONResponse:
    logger.warning(
        "HTTP %s %s: %s",
        exc.status_code,
        request.url.path,
        exc.detail,
    )

    return JSONResponse(
        status_code=exc.status_code,
        content={
            "detail": exc.detail,
        },
    )


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(
    request: Request,
    exc: RequestValidationError,
) -> JSONResponse:
    logger.warning(
        "Ошибка валидации %s: %s",
        request.url.path,
        exc.errors(),
    )

    errors = [{key: value for key, value in error.items() if key != "ctx"} for error in exc.errors()]
    return JSONResponse(
        status_code=422,
        content={
            "detail": "Некорректный запрос",
            "errors": errors,
        },
    )


@app.exception_handler(Exception)
async def unhandled_exception_handler(
    request: Request,
    exc: Exception,
) -> JSONResponse:
    logger.exception(
        "Необработанная ошибка в %s %s",
        request.method,
        request.url.path,
    )

    return JSONResponse(
        status_code=500,
        content={
            "detail": (
                "Внутренняя ошибка сервера. "
                "Подробности — в логах контейнера rag."
            ),
            "error_type": type(exc).__name__,
        },
    )


def stable_point_id(
    digest: str,
    chunk_index: int,
) -> str:
    raw = f"{digest}:{chunk_index}"
    return str(uuid.uuid5(uuid.NAMESPACE_URL, raw))


@app.get("/")
def index() -> FileResponse:
    return FileResponse("app/static/index.html")


@app.get("/api/files")
def list_files() -> dict:
    files: list[dict] = []


    for path in document_files(DOCS_DIR):

        files.append(
        {
            "name": path.name,
            "relative_path": str(
                path.relative_to(DOCS_DIR)
            ).replace("\\", "/"),
            "size_mb": round(
                path.stat().st_size / 1024 / 1024,
                2,
                ),
            "type": path.suffix.lower().replace(".", "").upper(),
            "mtime": path.stat().st_mtime,
            }
        )

    return {
        "files": files,
        "total": len(files),
    }


@app.get("/api/document/{file_path:path}")
def get_document(file_path: str) -> FileResponse:
    requested_path = (DOCS_DIR / file_path).resolve()

    if not requested_path.is_relative_to(DOCS_DIR):
        raise HTTPException(
            status_code=403,
            detail="Доступ к файлу запрещён",
        )

    if not requested_path.is_file():
        raise HTTPException(
            status_code=404,
            detail="Файл не найден",
        )

    if requested_path.suffix.lower() not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail="Неподдерживаемый тип файла",
        )

    return FileResponse(requested_path)


def indexing_options() -> dict:
    return {"docs_dir": DOCS_DIR, "processed_dir": PROCESSED_DIR,
            "qdrant_url": QDRANT_URL, "collection": COLLECTION,
            "embedder": embedder, "embed_batch_size": EMBED_BATCH_SIZE}


def start_indexing(files, kind="base", force=False, prepare=None):
    try:
        return indexing_manager.start(files, indexing_options(), kind, force, prepare)
    except IndexingBusy as error:
        raise HTTPException(status_code=409, detail=str(error))


def base_indexing():
    return start_indexing(document_files(DOCS_DIR))


async def upload_indexing(file: UploadFile):
    original_name = Path(file.filename or "").name
    if Path(original_name).suffix.lower() not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Неподдерживаемый формат файла")
    target = (DOCS_DIR / original_name).resolve()
    if not target.is_relative_to(DOCS_DIR):
        raise HTTPException(status_code=403, detail="Доступ к файлу запрещён")
    # Stage a unique file; a conflicting job must never overwrite an active input.
    staging = DOCS_DIR / f".{uuid.uuid4().hex}.upload"
    try:
        with staging.open("wb") as output:
            while chunk := await file.read(1024 * 1024):
                output.write(chunk)
        job = start_indexing([target], "upload", prepare=lambda: staging.replace(target))
        return job
    finally:
        staging.unlink(missing_ok=True)


@app.post("/api/indexing/start", status_code=202)
def start_base_indexing() -> dict:
    return base_indexing().snapshot()


@app.post("/api/indexing/upload", status_code=202)
async def start_upload_indexing(file: UploadFile = File(...)) -> dict:
    job = await upload_indexing(file)
    return job.snapshot()


@app.get("/api/indexing/status")
def indexing_status(job_id: str | None = None) -> JSONResponse:
    job = require_indexing_job(job_id) if job_id else indexing_manager.get()
    return JSONResponse(content={"job": job.snapshot() if job else None},
                        headers={"Cache-Control": "no-store"})


@app.get("/api/indexing/summary")
def indexing_summary() -> JSONResponse:
    job = indexing_manager.get()
    revision = (job.id, job.done.is_set()) if job else None
    try:
        summary = index_summary.get(DOCS_DIR, QDRANT_URL, COLLECTION, revision)
        return JSONResponse(content=summary, headers={"Cache-Control": "no-store"})
    except Exception:
        logger.exception("Не удалось получить сводку индексации")
        return JSONResponse(status_code=503, content={"indexed_documents": None,
            "total_documents": len(document_files(DOCS_DIR)),
            "detail": "Не удалось получить сводку индексации из Qdrant"})


def require_indexing_job(job_id):
    job = indexing_manager.get(job_id)
    if job is None:
        raise HTTPException(status_code=404, detail="Задача индексации не найдена")
    return job


@app.post("/api/indexing/{job_id}/pause")
def pause_indexing(job_id: str) -> dict:
    return require_indexing_job(job_id).pause()


@app.post("/api/indexing/{job_id}/resume")
def resume_indexing(job_id: str) -> dict:
    return require_indexing_job(job_id).resume()


# Synchronous contracts remain available for existing API clients.
@app.post("/upload")
async def upload(file: UploadFile = File(...)) -> dict:
    job = await upload_indexing(file)
    result = await run_in_threadpool(job.wait)
    if result["errors"]:
        raise HTTPException(status_code=500, detail="Не удалось проиндексировать файл")
    return {"saved": job.files[0].name, **result}


@app.post("/reindex")
def reindex() -> dict:
    return base_indexing().wait()


@app.post("/reindex-file/{file_path:path}")
def reindex_file(file_path: str) -> dict:
    target = (DOCS_DIR / file_path).resolve()
    if not target.is_relative_to(DOCS_DIR):
        raise HTTPException(status_code=403, detail="Доступ к файлу запрещён")
    if not target.is_file():
        raise HTTPException(status_code=404, detail="Файл не найден")
    if target.suffix.lower() not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Неподдерживаемый тип файла")
    result = start_indexing([target], "upload", force=True).wait()
    if result["errors"]:
        raise HTTPException(status_code=500, detail="Ошибка переиндексации файла")
    return result


@app.post("/ask")
def ask(request: AskRequest) -> dict:
    question = request.question.strip()

    if not question:
        raise HTTPException(
            status_code=400,
            detail="Пустой запрос",
        )

    history = trim_history([message.model_dump() for message in request.history], history_budget(question))
    context_info = {
        "messages_used": len(history),
        "history_limited": len(history) < len(request.history)
        or any(len(message.content.encode("utf-8")) > 1800 for message in request.history),
    }
    try:
        retrieval_query = rewrite_search_query(question, history, OLLAMA_URL, LLM_MODEL)
    except Exception:
        logger.exception("Ошибка восстановления темы диалога")
        raise HTTPException(status_code=502, detail="Не удалось восстановить контекст диалога. Повторите запрос.")

    try:
        contexts = search(
            query=retrieval_query,
            qdrant_url=QDRANT_URL,
            collection=COLLECTION,
            embedder=embedder,
            top_k=request.top_k,
        )
        contexts.sort(key=lambda item: item.get("score", 0), reverse=True)
    except Exception:
        logger.exception("Ошибка поиска в Qdrant")
        raise HTTPException(
            status_code=502,
            detail=(
                "Ошибка обращения к векторной базе Qdrant."
            ),
        )

    if not contexts:
        return {
            "answer": (
                "Векторная база пуста. "
                "Загрузите и проиндексируйте документы."
            ),
            "sources": [],
            "context": context_info,
        }

    try:
        answer = generate_answer(
            question=question,
            contexts=contexts,
            ollama_url=OLLAMA_URL,
            model=LLM_MODEL,
            history=history,
        )
    except Exception:
        logger.exception("Ошибка генерации ответа Ollama")
        raise HTTPException(
            status_code=502,
            detail=(
                "Ошибка обращения к локальной LLM Ollama. "
                "Проверьте, запущена ли модель и достаточно ли памяти."
            ),
        )

    return {
        "answer": answer,
        "sources": contexts,
        "context": context_info,
    }


app.mount(
    "/assets",
    StaticFiles(directory="frontend/assets"),
    name="frontend-assets",
)


app.mount(
    "/static",
    StaticFiles(directory="app/static"),
    name="static",
)
