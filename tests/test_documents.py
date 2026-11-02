"""Count source documents against Qdrant metadata, not extraction caches."""
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from test_dialogue import main, temporary
from fastapi.testclient import TestClient
from app.documents import document_files, IndexSummary


class DocumentSummaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="rag-md-inventory-")
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        for name in ["Нормы/a.pdf", "Нормы/b.txt", "Нормы/_ocr_a/page-01.txt", "x.upload", "a.exe"]:
            path = self.folder / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("test", encoding="utf-8")

    def test_inventory_excludes_generated_ocr_but_keeps_source_text(self):
        for name in ["scan.djvu", "scan.ppm", "scan.txt"]:
            (self.folder / name).write_text("test")
        self.assertEqual({p.relative_to(self.folder).as_posix() for p in document_files(self.folder)},
                         {"Нормы/a.pdf", "Нормы/b.txt", "scan.djvu"})

    def test_summary_deduplicates_chunks_and_excludes_missing_files(self):
        client = Mock()
        client.collection_exists.return_value = True
        point = lambda file: types.SimpleNamespace(payload={"file": file})
        client.scroll.side_effect = [([point("Нормы/a.pdf"), point("Нормы/a.pdf")], "next"),
            ([point("deleted.pdf"), point("Нормы/_ocr_a/page-01.txt")], None)]
        with patch("app.documents.QdrantClient", return_value=client):
            summary = IndexSummary().get(self.folder, "http://qdrant", "docs")
        self.assertEqual(summary, {"indexed_documents": 1, "total_documents": 2})
        self.assertEqual(client.scroll.call_count, 2)
        self.assertFalse(client.scroll.call_args.kwargs["with_vectors"])

    def test_empty_collection_and_cache_refresh_after_reset(self):
        now = [0]
        cache = IndexSummary(clock=lambda: now[0])
        client = Mock()
        client.collection_exists.return_value = True
        client.scroll.return_value = ([types.SimpleNamespace(payload={"file": "Нормы/a.pdf"})], None)
        with patch("app.documents.QdrantClient", return_value=client):
            self.assertEqual(cache.get(self.folder, "q", "docs")["indexed_documents"], 1)
            cache.get(self.folder, "q", "docs")
            self.assertEqual(client.scroll.call_count, 1)
            now[0] = 11
            client.collection_exists.return_value = False
            self.assertEqual(cache.get(self.folder, "q", "docs")["indexed_documents"], 0)

    def test_api_does_not_report_false_zero_when_qdrant_is_unavailable(self):
        with patch.object(main, "DOCS_DIR", self.folder), patch.object(main.index_summary, "get", side_effect=RuntimeError("offline")):
            response = TestClient(main.app).get("/api/indexing/summary")
        self.assertEqual(response.status_code, 503)
        self.assertIsNone(response.json()["indexed_documents"])
        self.assertEqual(response.json()["total_documents"], 2)


if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        temporary.cleanup()
