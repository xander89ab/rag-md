import logging
import os
import uuid
from pathlib import Path

import torch
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from sentence_transformers import SentenceTransformer

from .ingest import ingest_directory, ingest_single_file
from .rag import generate_answer, search

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
LLM_MODEL = os.getenv("LLM_MODEL", "qwen2.5:3b-instruct")
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


class AskRequest(BaseModel):
    question: str
    top_k: int = 8


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

    return JSONResponse(
        status_code=422,
        content={
            "detail": "Некорректный запрос",
            "errors": exc.errors(),
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


    for path in sorted(DOCS_DIR.rglob("*")):
        if not path.is_file():
            continue

        if path.suffix.lower() not in ALLOWED_EXTENSIONS:
            continue

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


@app.post("/upload")
async def upload(
    file: UploadFile = File(...),
) -> dict:
    original_name = Path(file.filename or "").name
    suffix = Path(original_name).suffix.lower()

    if suffix not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Формат {suffix or 'файла'} "
                f"не поддерживается"
            ),
        )

    target = DOCS_DIR / original_name
    target.parent.mkdir(parents=True, exist_ok=True)

    with target.open("wb") as output:
        while chunk := await file.read(1024 * 1024):
            output.write(chunk)

    try:
        result = ingest_single_file(
            file_path=target,
            docs_dir=DOCS_DIR,
            processed_dir=PROCESSED_DIR,
            qdrant_url=QDRANT_URL,
            collection=COLLECTION,
            embedder=embedder,
            embed_batch_size=EMBED_BATCH_SIZE,
            force_reindex=False,
        )
    except Exception:
        logger.exception(
            "Ошибка индексации файла: %s",
            original_name,
        )
        raise HTTPException(
            status_code=500,
            detail=(
                "Не удалось проиндексировать файл. "
                "Проверьте логи контейнера rag."
            ),
        )

    return {
        "saved": original_name,
        **result,
    }


@app.post("/reindex")
def reindex() -> dict:
    try:
        return ingest_directory(
            docs_dir=str(DOCS_DIR),
            processed_dir=str(PROCESSED_DIR),
            qdrant_url=QDRANT_URL,
            collection=COLLECTION,
            embedder=embedder,
            embed_batch_size=EMBED_BATCH_SIZE,
        )
    except Exception:
        logger.exception("Ошибка полной переиндексации")
        raise HTTPException(
            status_code=500,
            detail="Ошибка переиндексации базы",
        )


@app.post("/reindex-file/{file_path:path}")
def reindex_file(file_path: str) -> dict:
    target = (DOCS_DIR / file_path).resolve()

    if not target.is_relative_to(DOCS_DIR):
        raise HTTPException(
            status_code=403,
            detail="Доступ к файлу запрещён",
        )

    if not target.is_file():
        raise HTTPException(
            status_code=404,
            detail="Файл не найден",
        )

    if target.suffix.lower() not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail="Неподдерживаемый тип файла",
        )

    try:
        return ingest_single_file(
            file_path=target,
            docs_dir=DOCS_DIR,
            processed_dir=PROCESSED_DIR,
            qdrant_url=QDRANT_URL,
            collection=COLLECTION,
            embedder=embedder,
            embed_batch_size=EMBED_BATCH_SIZE,
            force_reindex=True,
        )
    except Exception:
        logger.exception(
            "Ошибка переиндексации файла: %s",
            target,
        )
        raise HTTPException(
            status_code=500,
            detail="Ошибка переиндексации файла",
        )


@app.post("/ask")
def ask(request: AskRequest) -> dict:
    question = request.question.strip()

    if not question:
        raise HTTPException(
            status_code=400,
            detail="Пустой запрос",
        )

    try:
        contexts = search(
            query=question,
            qdrant_url=QDRANT_URL,
            collection=COLLECTION,
            embedder=embedder,
            top_k=request.top_k,
        )
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
        }

    try:
        answer = generate_answer(
            question=question,
            contexts=contexts,
            ollama_url=OLLAMA_URL,
            model=LLM_MODEL,
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
    }


app.mount(
    "/static",
    StaticFiles(directory="app/static"),
    name="static",
)