"""One cooperative indexing worker shared by all HTTP clients of this process."""
import logging
import threading
import time
import uuid
from pathlib import Path

from .ingest import ingest_single_file

logger = logging.getLogger(__name__)
ACTIVE = {"running", "pause_requested", "paused"}


class IndexingBusy(Exception):
    pass


class IndexingJob:
    def __init__(self, files, options, kind, force=False, clock=time.monotonic):
        self.id = str(uuid.uuid4())
        self.files = files
        self.options = options
        self.kind = kind
        self.force = force
        self.clock = clock
        self.lock = threading.RLock()
        self.condition = threading.Condition(self.lock)
        self.done = threading.Event()
        self.state = "running"
        self.started = clock()
        self.ended = None
        self.paused_at = None
        self.paused_seconds = 0
        self.completed = 0
        self.current_file = ""
        self.stage = "preparing"
        self.stage_done = 0
        self.stage_total = 0
        self.file_fraction = 0
        self.weights = [max(path.stat().st_size, 1) for path in files]
        self.sample_ready = False
        self.result = {"files": len(files), "indexed_files": 0, "skipped_files": 0,
                       "empty_files": 0, "chunks": 0, "errors": []}

    def checkpoint(self, stage=None, done=0, total=0):
        with self.condition:
            if self.state == "pause_requested":
                self.state = "paused"
                self.paused_at = self.clock()
            while self.state == "paused":
                self.condition.wait()
            if stage:
                self.stage, self.stage_done, self.stage_total = stage, done, total
                ratio = min(1, done / total) if total else 0
                self.file_fraction = {"hashing": 0, "extracting": .05 + .4 * ratio,
                                      "ocr": .05 + .4 * ratio, "embedding": .45 + .5 * ratio,
                                      "saving": .95}.get(stage, 0)
                if stage in {"embedding", "ocr"} and done > 0:
                    self.sample_ready = True

    def pause(self):
        with self.condition:
            if self.state == "running":
                self.state = "pause_requested"
            return self.snapshot()

    def resume(self):
        with self.condition:
            if self.state == "paused":
                self.paused_seconds += self.clock() - self.paused_at
                self.paused_at = None
            if self.state in {"paused", "pause_requested"}:
                self.state = "running"
                self.condition.notify_all()
            return self.snapshot()

    def snapshot(self):
        with self.lock:
            now = self.ended if self.ended is not None else self.clock()
            paused = self.paused_seconds + (now - self.paused_at if self.paused_at is not None else 0)
            elapsed = max(0, now - self.started - paused)
            weight_done = sum(self.weights[:self.completed])
            if self.completed < len(self.files):
                weight_done += self.weights[self.completed] * self.file_fraction
            fraction = weight_done / sum(self.weights) if self.weights else 1
            eta = None
            if self.state == "completed":
                eta = 0
            elif self.sample_ready and 0 < fraction < 1:
                eta = max(1, round(elapsed * (1 - fraction) / fraction))
            return {"id": self.id, "kind": self.kind, "state": self.state,
                    "total_files": len(self.files), "completed_files": self.completed,
                    "current_file": self.current_file, "stage": self.stage,
                    "stage_done": self.stage_done, "stage_total": self.stage_total,
                    "elapsed_seconds": round(elapsed), "estimated_remaining_seconds": eta,
                    "result": self.result if self.done.is_set() else None}

    def run(self):
        try:
            for path in self.files:
                self.checkpoint()
                with self.lock:
                    self.current_file = str(path.relative_to(self.options["docs_dir"])).replace("\\", "/")
                    self.file_fraction = 0
                try:
                    result = ingest_single_file(file_path=path, force_reindex=self.force,
                                                progress=self.checkpoint, **self.options)
                    with self.lock:
                        if self.kind == "upload":
                            self.result.update(result)
                        if result["status"] == "indexed":
                            self.result["indexed_files"] += 1
                            self.result["chunks"] = self.result["chunks"] + result["chunks"] if self.kind != "upload" else result["chunks"]
                        elif result["status"] == "skipped":
                            self.result["skipped_files"] += 1
                        elif result["status"] == "empty":
                            self.result["empty_files"] += 1
                except Exception as error:
                    logger.exception("Indexing failed for %s", path.name)
                    with self.lock:
                        self.result["errors"].append({"file": path.name, "error": str(error)})
                with self.lock:
                    self.completed += 1
                    self.file_fraction = 0
                    self.sample_ready = True
            with self.condition:
                self.state = "completed"
        except Exception:
            logger.exception("Indexing job failed")
            with self.condition:
                self.state = "failed"
        finally:
            with self.lock:
                self.ended = self.clock()
                if self.paused_at is not None:
                    self.paused_seconds += self.ended - self.paused_at
                    self.paused_at = None
                self.done.set()

    def wait(self):
        self.done.wait()
        if self.state == "failed":
            raise RuntimeError("Индексация прервана")
        return self.result


class IndexingManager:
    def __init__(self):
        self.lock = threading.Lock()
        self.job = None
        self.jobs = {}

    def start(self, files, options, kind="base", force=False, prepare=None):
        with self.lock:
            if self.job and not self.job.done.is_set():
                raise IndexingBusy("Индексация уже запущена")
            if prepare:
                prepare()
            job = IndexingJob(files, options, kind, force)
            self.job = job
            self.jobs[job.id] = job
            for job_id in list(self.jobs)[:-20]:
                del self.jobs[job_id]
            threading.Thread(target=job.run, daemon=True, name="indexing-" + job.id).start()
            return job

    def get(self, job_id=None):
        with self.lock:
            return self.jobs.get(job_id) if job_id else self.job
