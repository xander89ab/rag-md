"""Exercise background jobs, real pause/resume, ETA and indexing checkpoints."""
import importlib.util
import sys
import threading
import time
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

# Shared lightweight FastAPI fixture (models and OCR are not started).
from test_dialogue import main, temporary
from fastapi.testclient import TestClient
from app import indexing


def until(predicate, timeout=3):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return
        time.sleep(.005)
    raise AssertionError("Background worker did not reach the expected state")


class IndexingTests(unittest.TestCase):
    def setUp(self):
        self.folder = main.DOCS_DIR
        self.file = self.folder / "test.txt"
        self.file.write_text("Document text " * 300, encoding="utf-8")
        self.options = {"docs_dir": self.folder}

    def test_api_pause_stops_worker_and_resume_continues_same_job(self):
        started, finish_batch, next_batch = threading.Event(), threading.Event(), threading.Event()

        def ingest(progress, **kwargs):
            progress("embedding", 0, 2)
            started.set()
            if not finish_batch.wait(3):
                raise AssertionError("Batch was not released")
            progress("embedding", 1, 2)
            next_batch.set()
            return {"status": "indexed", "chunks": 2}

        manager = indexing.IndexingManager()
        with patch.object(main, "indexing_manager", manager), patch.object(indexing, "ingest_single_file", side_effect=ingest):
            client = TestClient(main.app)
            response = client.post("/api/indexing/start")
            self.assertEqual(response.status_code, 202)
            job_id = response.json()["id"]
            job = manager.get(job_id)
            try:
                self.assertTrue(started.wait(3))
                self.assertEqual(client.post(f"/api/indexing/{job_id}/pause").json()["state"], "pause_requested")
                self.assertEqual(client.post("/api/indexing/start").status_code, 409)
                # A conflicting upload must not overwrite the current input.
                original = self.file.read_bytes()
                self.assertEqual(client.post("/api/indexing/upload", files={"file": ("test.txt", b"replacement")}).status_code, 409)
                self.assertEqual(self.file.read_bytes(), original)
                finish_batch.set()
                until(lambda: job.snapshot()["state"] == "paused")
                self.assertFalse(next_batch.is_set())
                self.assertEqual(job.snapshot()["completed_files"], 0)
                self.assertEqual(client.get("/api/indexing/status").json()["job"]["state"], "paused")
                self.assertEqual(client.post(f"/api/indexing/{job_id}/resume").status_code, 200)
                self.assertTrue(job.done.wait(3))
                result = client.get("/api/indexing/status", params={"job_id": job_id}).json()["job"]
                self.assertEqual(result["id"], job_id)
                self.assertEqual(result["state"], "completed")
                self.assertEqual(result["result"]["chunks"], 2)
                self.assertTrue(next_batch.is_set())
                self.assertEqual(client.post("/api/indexing/missing/pause").status_code, 404)
            finally:
                finish_batch.set()
                job.resume()
                job.done.wait(3)

    def test_eta_is_unknown_until_sample_and_excludes_paused_time(self):
        now = [0]
        job = indexing.IndexingJob([self.file, self.file], self.options, "base", clock=lambda: now[0])
        self.assertIsNone(job.snapshot()["estimated_remaining_seconds"])
        now[0] = 10
        job.checkpoint("embedding", 1, 2)
        before = job.snapshot()
        self.assertGreater(before["estimated_remaining_seconds"], 0)
        job.pause()
        worker = threading.Thread(target=job.checkpoint)
        worker.start()
        try:
            until(lambda: job.snapshot()["state"] == "paused")
            now[0] = 110
            paused = job.snapshot()
            self.assertEqual(paused["elapsed_seconds"], before["elapsed_seconds"])
            self.assertEqual(paused["estimated_remaining_seconds"], before["estimated_remaining_seconds"])
        finally:
            job.resume()
            worker.join(3)
        now[0] = 115
        self.assertEqual(job.snapshot()["elapsed_seconds"], 15)

    def test_worker_reports_errors_and_finishes_empty_database(self):
        manager = indexing.IndexingManager()
        job = manager.start([], self.options)
        self.assertTrue(job.done.wait(3))
        self.assertEqual(job.snapshot()["estimated_remaining_seconds"], 0)
        self.assertEqual(job.wait()["files"], 0)
        with patch.object(indexing, "ingest_single_file", side_effect=RuntimeError("OCR failed")):
            failed_file = manager.start([self.file], self.options)
            self.assertTrue(failed_file.done.wait(3))
            self.assertEqual(len(failed_file.wait()["errors"]), 1)
        self.assertIs(manager.get(job.id), job)

    def test_real_pipeline_reports_each_embedding_batch_before_upsert(self):
        models = types.SimpleNamespace(**{name: Mock() for name in ["Distance", "FieldCondition", "Filter", "MatchValue", "PointStruct", "VectorParams"]})
        module_name = "app.test_ingest_pipeline"
        spec = importlib.util.spec_from_file_location(module_name, Path(main.__file__).with_name("ingest.py"))
        ingest = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"qdrant_client.models": models}):
            spec.loader.exec_module(ingest)
        client, embedder = Mock(), Mock()
        client.collection_exists.return_value = False
        vector = types.SimpleNamespace(tolist=lambda: [1, 0, 0])
        embedder.encode.side_effect = lambda texts, **kwargs: [vector for _ in texts]
        reports = []
        with patch.object(ingest, "QdrantClient", return_value=client), patch.object(ingest, "load_or_extract", return_value="sample " * 600):
            result = ingest.ingest_single_file(self.file, self.folder, main.PROCESSED_DIR,
                "http://qdrant", "docs", embedder, embed_batch_size=1,
                progress=lambda *args: reports.append(args))
        self.assertGreater(result["chunks"], 1)
        self.assertEqual(embedder.encode.call_count, result["chunks"])
        batches = [report for report in reports if report[0] == "embedding"]
        self.assertEqual(batches[0], ("embedding", 0, result["chunks"]))
        self.assertEqual(batches[-1], ("embedding", result["chunks"], result["chunks"]))
        self.assertEqual(reports[-1][0], "saving")
        self.assertEqual(len(client.upsert.call_args.kwargs["points"]), result["chunks"])


if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        temporary.cleanup()
