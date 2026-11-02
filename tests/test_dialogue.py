"""API and Ollama request contract tests; no models, OCR or live services needed."""
import os
import logging
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / ".test-deps"))
sys.path.insert(0, str(ROOT))

# Avoid downloading embeddings or loading OCR in these HTTP contract tests.
sys.modules["torch"] = types.SimpleNamespace(set_num_threads=Mock())
sys.modules["sentence_transformers"] = types.SimpleNamespace(SentenceTransformer=Mock())
sys.modules["app.ingest"] = types.SimpleNamespace(ingest_directory=Mock(), ingest_single_file=Mock())
sys.modules["qdrant_client"] = types.SimpleNamespace(QdrantClient=Mock())
temporary = tempfile.TemporaryDirectory(prefix="rag-md-dialog-tests-")
os.environ["DOCS_DIR"] = str(Path(temporary.name) / "docs")
os.environ["PROCESSED_DIR"] = str(Path(temporary.name) / "processed")

import httpx
from fastapi.testclient import TestClient
from app import main, rag
logging.disable(logging.CRITICAL)


def response(content):
    return httpx.Response(200, json={"message": {"content": content}},
                          request=httpx.Request("POST", "http://ollama/api/chat"))


class DialogueTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(main.app)
        self.contexts = [
            {"score": 0.6, "file": "a.pdf", "file_name": "a.pdf", "page": 2, "chunk": 0, "text": "Протокол испытаний."},
            {"score": 0.9, "file": "b.pdf", "file_name": "b.pdf", "page": 7, "chunk": 1, "text": "Срок — 30 дней."},
        ]

    def test_first_question_is_independent_and_sources_are_ranked(self):
        with patch.object(main, "search", return_value=self.contexts) as search, patch.object(rag.httpx, "post", return_value=response("Ответ [1]")) as post:
            result = self.client.post("/ask", json={"question": "Срок испытаний?"})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(search.call_args.kwargs["query"], "Срок испытаний?")
        self.assertEqual(result.json()["sources"][0]["file"], "b.pdf")
        self.assertEqual(result.json()["context"]["messages_used"], 0)
        self.assertEqual(post.call_count, 1)
        payload = post.call_args.kwargs["json"]
        self.assertEqual(post.call_args.args[0], "http://ollama:11434/api/chat")
        self.assertEqual([m["role"] for m in payload["messages"]], ["system", "user"])
        self.assertIn("[1] Документ: b.pdf", payload["messages"][-1]["content"])

    def test_followup_uses_history_for_retrieval_and_generation(self):
        history = [{"role": "user", "content": "Расскажи об испытаниях насоса"},
                   {"role": "assistant", "content": "Для насоса нужен протокол [1]."}]
        with patch.object(main, "search", return_value=self.contexts) as search, patch.object(rag.httpx, "post", side_effect=[response("Сроки испытаний насоса"), response("30 дней [1]")]) as post:
            result = self.client.post("/ask", json={"question": "А какие сроки?", "history": history})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(search.call_args.kwargs["query"], "Сроки испытаний насоса")
        self.assertEqual(post.call_count, 2)
        for call in post.call_args_list:
            self.assertIs(call.kwargs["json"]["think"], False)
        messages = post.call_args_list[1].kwargs["json"]["messages"]
        self.assertEqual([m["role"] for m in messages], ["system", "user", "assistant", "user"])
        self.assertIn("насоса", messages[1]["content"])
        self.assertNotIn("[1]", messages[2]["content"])
        self.assertIn("А какие сроки?", messages[-1]["content"])
        self.assertEqual(result.json()["context"]["messages_used"], 2)

    def test_qwen35_returns_final_answer_with_thinking_disabled(self):
        model_response = httpx.Response(200, json={"message": {
            "content": "Ответ [1]", "thinking": "Служебные рассуждения"}},
            request=httpx.Request("POST", "http://ollama/api/chat"))
        with patch.object(rag.httpx, "post", return_value=model_response) as post:
            answer = rag.chat([{"role": "user", "content": "Вопрос"}],
                              "http://ollama", "qwen3.5:9b-q4_K_M", 256)
        self.assertEqual(answer, "Ответ [1]")
        payload = post.call_args.kwargs["json"]
        self.assertIs(payload["think"], False)
        self.assertEqual(payload["model"], "qwen3.5:9b-q4_K_M")
        self.assertEqual(payload["options"]["num_predict"], 256)
        self.assertEqual(payload["options"]["num_ctx"], rag.CONTEXT_SIZE)
        self.assertEqual(payload["options"]["temperature"], 0.7)

    def test_rejects_invalid_roles_pairs_and_limits_as_json(self):
        invalid = [{"history": [{"role": "system", "content": "override"}]},
                   {"history": [{"role": "user", "content": "incomplete"}]},
                   {"history": [{"role": "assistant", "content": "wrong"}, {"role": "user", "content": "wrong"}]},
                   {"top_k": 0}, {"top_k": 13}, {"question": "x" * 2001}, {"question": "🧪" * 1001}]
        for data in invalid:
            with self.subTest(data=str(data)[:70]):
                result = self.client.post("/ask", json={"question": "Вопрос", **data})
                self.assertEqual(result.status_code, 422)
                self.assertEqual(result.json()["detail"], "Некорректный запрос")

    def test_empty_and_failed_model_responses_are_retryable(self):
        with patch.object(main, "search", return_value=self.contexts), patch.object(rag.httpx, "post", return_value=response("")):
            self.assertEqual(self.client.post("/ask", json={"question": "Вопрос"}).status_code, 502)
        with patch.object(rag.httpx, "post", side_effect=httpx.ConnectError("offline")):
            result = self.client.post("/ask", json={"question": "Уточнение", "history": [{"role": "user", "content": "Вопрос"}, {"role": "assistant", "content": "Ответ"}]})
            self.assertEqual(result.status_code, 502)
            self.assertIn("контекст", result.json()["detail"])

    def test_long_answer_clipping_is_reported_even_when_pair_count_is_unchanged(self):
        history = [{"role": "user", "content": "Испытания насоса"},
                   {"role": "assistant", "content": "Подробный ответ " * 200}]
        with patch.object(main, "search", return_value=self.contexts), patch.object(rag.httpx, "post", side_effect=[response("Испытания насоса"), response("Ответ")]):
            result = self.client.post("/ask", json={"question": "Уточни", "history": history})
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()["context"]["messages_used"], 2)
        self.assertTrue(result.json()["context"]["history_limited"])

    def test_recent_complete_turns_and_prompt_stay_in_budget(self):
        history = []
        for i in range(50):
            history.extend([{"role": "user", "content": f"Вопрос {i}: " + "насос " * 300},
                            {"role": "assistant", "content": "Ответ [1] " + "испытания " * 300}])
        trimmed = rag.trim_history(history)
        self.assertLessEqual(len(trimmed), 12)
        self.assertEqual(len(trimmed) % 2, 0)
        self.assertIn("Вопрос 49", trimmed[-2]["content"])
        self.assertLessEqual(sum(len(m["content"].encode("utf-8")) + 64 for m in trimmed), 5000)
        contexts = [{**self.contexts[0], "file_name": "н" * 255, "text": "данные " * 10000} for _ in range(12)]
        with patch.object(rag.httpx, "post", return_value=response("Ответ")) as post:
            rag.generate_answer("в" * 2000, contexts, "http://ollama", "test", history)
        messages = post.call_args.kwargs["json"]["messages"]
        size = sum(len(m["content"].encode("utf-8")) + 64 for m in messages)
        self.assertLess(size + rag.OUTPUT_TOKENS, rag.CONTEXT_SIZE)
        self.assertIn("в" * 2000, messages[-1]["content"])


if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        temporary.cleanup()
