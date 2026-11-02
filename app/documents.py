"""Source-document inventory and a summary of the actual vector collection."""
import threading
import time
from pathlib import Path

from qdrant_client import QdrantClient

DOCUMENT_EXTENSIONS = {".pdf", ".djvu", ".djv", ".txt", ".md"}


def document_files(docs_dir: Path) -> list[Path]:
    files = []
    for path in docs_dir.rglob("*"):
        relative = path.relative_to(docs_dir)
        if any(part.startswith("_ocr_") for part in relative.parts[:-1]):
            continue
        if path.suffix.lower() not in DOCUMENT_EXTENSIONS or not path.is_file():
            continue
        if not path.resolve().is_relative_to(docs_dir.resolve()):
            continue
        # DjVu fallback OCR writes a sibling TXT and PPM with the same stem.
        if path.suffix.lower() == ".txt" and path.with_suffix(".ppm").is_file() and any(
            path.with_suffix(extension).is_file() for extension in (".djvu", ".djv")
        ):
            continue
        files.append(path)
    return sorted(files)


class IndexSummary:
    def __init__(self, ttl=10, clock=time.monotonic):
        self.lock = threading.Lock()
        self.ttl = ttl
        self.clock = clock
        self.updated = None
        self.key = None
        self.indexed_paths = set()

    def get(self, docs_dir, qdrant_url, collection, revision=None):
        current = {path.relative_to(docs_dir).as_posix() for path in document_files(docs_dir)}
        with self.lock:
            key = (qdrant_url, collection, revision)
            if self.key != key or self.updated is None or self.clock() - self.updated >= self.ttl:
                client = QdrantClient(url=qdrant_url, timeout=60)
                try:
                    indexed = set()
                    if client.collection_exists(collection):
                        offset = None
                        while True:
                            points, offset = client.scroll(collection_name=collection, limit=1000,
                                offset=offset, with_payload=["file"], with_vectors=False)
                            for point in points:
                                value = (point.payload or {}).get("file")
                                if isinstance(value, str):
                                    indexed.add(value.replace("\\", "/"))
                            if offset is None:
                                break
                finally:
                    client.close()
                self.indexed_paths, self.key, self.updated = indexed, key, self.clock()
        return {"indexed_documents": len(current & self.indexed_paths), "total_documents": len(current)}
