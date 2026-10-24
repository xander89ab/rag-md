import hashlib
import json
import re
import uuid
from pathlib import Path

from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance,
    FieldCondition,
    Filter,
    MatchValue,
    PointStruct,
    VectorParams,
)

from .ocr import extract_text


def clean_text(text: str) -> str:
    text = text.replace("\r", "")
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()

def make_point_id(
    digest: str,
    chunk_index: int,
) -> str:
    identity = f"rag-md:{digest}:{chunk_index}"

    return str(
        uuid.uuid5(
            uuid.NAMESPACE_URL,
            identity,
        )
    )

def split_text(
    text: str,
    chunk_size: int = 1200,
    overlap: int = 200,
) -> list[str]:
    text = clean_text(text)

    if not text:
        return []

    chunks: list[str] = []
    start = 0

    while start < len(text):
        end = min(start + chunk_size, len(text))

        if end < len(text):
            preferred_cut = text.rfind(
                "\n",
                start + int(chunk_size * 0.6),
                end,
            )

            if preferred_cut != -1:
                end = preferred_cut

        chunk = text[start:end].strip()

        if chunk:
            chunks.append(chunk)

        if end >= len(text):
            break

        start = max(end - overlap, start + 1)

    return chunks


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()

    with path.open("rb") as file:
        for block in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(block)

    return digest.hexdigest()


def prepare_chunks(
    path: Path,
    extracted: str | list[tuple[int, str]],
) -> list[tuple[int | None, str]]:
    if isinstance(extracted, list):
        chunks: list[tuple[int | None, str]] = []

        for page_number, page_text in extracted:
            for chunk in split_text(page_text):
                chunks.append((page_number, chunk))

        return chunks

    return [
        (None, chunk)
        for chunk in split_text(extracted)
    ]


def load_or_extract(
    path: Path,
    digest: str,
    processed_dir: Path,
) -> str | list[tuple[int, str]]:
    cache_file = processed_dir / f"{path.stem}_{digest[:12]}.json"

    if cache_file.exists():
        cached = json.loads(
            cache_file.read_text(encoding="utf-8")
        )

        return [
            (item["page"], item["text"])
            for item in cached
        ]

    extracted = extract_text(path)

    if isinstance(extracted, str):
        serialized = [
            {
                "page": None,
                "text": extracted,
            }
        ]
    else:
        serialized = [
            {
                "page": page_number,
                "text": page_text,
            }
            for page_number, page_text in extracted
        ]

    cache_file.write_text(
        json.dumps(
            serialized,
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    return extracted


def collection_exists(
    client: QdrantClient,
    collection: str,
) -> bool:
    try:
        return client.collection_exists(collection)
    except Exception:
        return False


def get_indexed_file_hashes(
    client: QdrantClient,
    collection: str,
) -> set[str]:
    if not collection_exists(client, collection):
        return set()

    indexed_hashes: set[str] = set()
    offset = None

    while True:
        points, next_offset = client.scroll(
            collection_name=collection,
            limit=256,
            offset=offset,
            with_payload=["sha256"],
            with_vectors=False,
        )

        for point in points:
            digest = point.payload.get("sha256")

            if digest:
                indexed_hashes.add(digest)

        if next_offset is None:
            break

        offset = next_offset

    return indexed_hashes


def delete_file_points(
    client: QdrantClient,
    collection: str,
    digest: str,
) -> None:
    if not collection_exists(client, collection):
        return

    client.delete(
        collection_name=collection,
        points_selector=Filter(
            must=[
                FieldCondition(
                    key="sha256",
                    match=MatchValue(value=digest),
                )
            ]
        ),
    )


def ingest_single_file(
    file_path: Path,
    docs_dir: Path,
    processed_dir: Path,
    qdrant_url: str,
    collection: str,
    embedder,
    embed_batch_size: int = 8,
    force_reindex: bool = False,
) -> dict:
    docs_dir = docs_dir.resolve()
    processed_dir = processed_dir.resolve()
    file_path = file_path.resolve()

    if not file_path.is_relative_to(docs_dir):
        raise ValueError("Файл находится вне разрешённого каталога")

    if not file_path.is_file():
        raise FileNotFoundError(f"Файл не найден: {file_path}")

    digest = file_hash(file_path)
    relative_path = str(
        file_path.relative_to(docs_dir)
    ).replace("\\", "/")

    client = QdrantClient(url=qdrant_url, timeout=120)
    vector_size = embedder.get_sentence_embedding_dimension()

    if not collection_exists(client, collection):
        client.create_collection(
            collection_name=collection,
            vectors_config=VectorParams(
                size=vector_size,
                distance=Distance.COSINE,
            ),
        )

    indexed_hashes = get_indexed_file_hashes(
        client,
        collection,
    )

    if digest in indexed_hashes and not force_reindex:
        return {
            "status": "skipped",
            "file": relative_path,
            "file_name": file_path.name,
            "sha256": digest,
            "chunks": 0,
            "reason": "Файл уже проиндексирован",
        }

    delete_file_points(
        client,
        collection,
        digest,
    )

    extracted = load_or_extract(
        path=file_path,
        digest=digest,
        processed_dir=processed_dir,
    )

    page_chunks = prepare_chunks(
        path=file_path,
        extracted=extracted,
    )

    if not page_chunks:
        return {
            "status": "empty",
            "file": relative_path,
            "file_name": file_path.name,
            "sha256": digest,
            "chunks": 0,
            "reason": "Не удалось извлечь текст",
        }

    texts = [
        f"passage: {chunk}"
        for _, chunk in page_chunks
    ]

    vectors = embedder.encode(
        texts,
        batch_size=embed_batch_size,
        normalize_embeddings=True,
        show_progress_bar=False,
    )

    points: list[PointStruct] = []

    for chunk_index, ((page_number, chunk), vector) in enumerate(
        zip(page_chunks, vectors)
    ):
        points.append(
            PointStruct(
                id=make_point_id(
                    digest=digest,
                    chunk_index=chunk_index,
                ),
                vector=vector.tolist(),
                payload={
                    "text": chunk,
                    "file": relative_path,
                    "file_name": file_path.name,
                    "chunk": chunk_index,
                    "page": page_number,
                    "sha256": digest,
                },
            )
        )

    client.upsert(
        collection_name=collection,
        points=points,
    )

    return {
        "status": "indexed",
        "file": relative_path,
        "file_name": file_path.name,
        "sha256": digest,
        "chunks": len(points),
    }


def ingest_directory(
    docs_dir: str,
    processed_dir: str,
    qdrant_url: str,
    collection: str,
    embedder,
    embed_batch_size: int = 8,
) -> dict:
    docs_path = Path(docs_dir).resolve()
    processed_path = Path(processed_dir).resolve()

    docs_path.mkdir(parents=True, exist_ok=True)
    processed_path.mkdir(parents=True, exist_ok=True)

    allowed_extensions = {
        ".pdf",
        ".djvu",
        ".djv",
        ".txt",
        ".md",
    }

    files = [
        path
        for path in docs_path.rglob("*")
        if path.is_file()
        and path.suffix.lower() in allowed_extensions
    ]

    indexed_files = 0
    skipped_files = 0
    total_chunks = 0
    errors: list[dict] = []

    for path in files:
        try:
            result = ingest_single_file(
                file_path=path,
                docs_dir=docs_path,
                processed_dir=processed_path,
                qdrant_url=qdrant_url,
                collection=collection,
                embedder=embedder,
                embed_batch_size=embed_batch_size,
                force_reindex=False,
            )

            if result["status"] == "indexed":
                indexed_files += 1
                total_chunks += result["chunks"]
            elif result["status"] == "skipped":
                skipped_files += 1

        except Exception as error:
            errors.append(
                {
                    "file": str(path),
                    "error": str(error),
                }
            )

    return {
        "files": len(files),
        "indexed_files": indexed_files,
        "skipped_files": skipped_files,
        "chunks": total_chunks,
        "errors": errors,
    }