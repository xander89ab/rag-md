import httpx
from qdrant_client import QdrantClient


def search(
    query: str,
    qdrant_url: str,
    collection: str,
    embedder,
    top_k: int = 8,
) -> list[dict]:
    client = QdrantClient(url=qdrant_url, timeout=60)

    vector = embedder.encode(
        f"query: {query}",
        normalize_embeddings=True,
    ).tolist()

    result = client.search(
        collection_name=collection,
        query_vector=vector,
        limit=top_k,
        with_payload=True,
    )

    sources: list[dict] = []

    for hit in result:
        payload = hit.payload

        sources.append(
            {
                "score": hit.score,
                "text": payload.get("text", ""),
                "file": payload.get("file", ""),
                "file_name": payload.get("file_name", ""),
                "chunk": payload.get("chunk", 0),
                "page": payload.get("page"),
            }
        )

    return sources


def build_prompt(
    question: str,
    contexts: list[dict],
) -> str:
    blocks: list[str] = []

    for index, context in enumerate(contexts, start=1):
        page = context.get("page")

        page_info = (
            f", страница {page}" if page else ""
        )

        blocks.append(
            f"[{index}] Документ: {context['file_name']}"
            f"{page_info}, фрагмент {context['chunk'] + 1}\n"
            f"{context['text']}"
        )

    context_text = "\n\n".join(blocks)

    return f"""Ты инженерный ассистент по нормативной и технической документации.

Отвечай только на основании приведённых фрагментов.
Не придумывай требования, номера пунктов, таблиц и формул.
Если приведённых данных недостаточно, напиши:
«В загруженной базе недостаточно данных для однозначного ответа».

В ответе указывай источники в квадратных скобках: [1], [2] и т. д.

Вопрос:
{question}

Фрагменты нормативных документов:
{context_text}
"""


def generate_answer(
    question: str,
    contexts: list[dict],
    ollama_url: str,
    model: str,
) -> str:
    prompt = build_prompt(question, contexts)

    response = httpx.post(
        f"{ollama_url}/api/generate",
        json={
            "model": model,
            "prompt": prompt,
            "stream": False,
            "options": {
                "temperature": 0.1,
                "num_ctx": 8192,
            },
        },
        timeout=600,
    )

    response.raise_for_status()
    return response.json().get("response", "")