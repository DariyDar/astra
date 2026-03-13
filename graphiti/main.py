"""
Graphiti REST server — bridges our TS bot with Graphiti + FalkorDB.

Endpoints wrap graphiti-core v0.28 API with FalkorDriver.
LLM: Gemini 2.0 Flash via litellm (through OpenAIClient).
"""

import asyncio
import os
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Optional

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

import config

# ── Graphiti / FalkorDB init ──

graphiti_instance = None
_init_lock = asyncio.Lock()


async def get_graphiti():
    """Lazy-init Graphiti with FalkorDB driver."""
    global graphiti_instance
    if graphiti_instance is not None:
        return graphiti_instance

    async with _init_lock:
        if graphiti_instance is not None:
            return graphiti_instance

        from graphiti_core import Graphiti
        from graphiti_core.driver.falkordb_driver import FalkorDriver
        from graphiti_core.llm_client import LLMConfig, OpenAIClient
        from graphiti_core.embedder import OpenAIEmbedder, OpenAIEmbedderConfig
        from graphiti_core.cross_encoder.gemini_reranker_client import GeminiRerankerClient

        # Set API key for litellm (used by OpenAIClient under the hood)
        os.environ["GEMINI_API_KEY"] = config.GEMINI_API_KEY

        falkor_driver = FalkorDriver(
            host=config.FALKORDB_HOST,
            port=config.FALKORDB_PORT,
            username=config.FALKORDB_USERNAME or None,
            password=config.FALKORDB_PASSWORD or None,
        )

        llm_config = LLMConfig(
            api_key=config.GEMINI_API_KEY,
            model=config.LLM_MODEL,
        )

        embedder_config = OpenAIEmbedderConfig(
            api_key=config.GEMINI_API_KEY,
            embedding_model=config.EMBEDDER_MODEL,
            embedding_dim=768,
        )

        reranker_config = LLMConfig(
            api_key=config.GEMINI_API_KEY,
            model="gemini/gemini-2.0-flash",
        )

        graphiti_instance = Graphiti(
            graph_driver=falkor_driver,
            llm_client=OpenAIClient(config=llm_config),
            embedder=OpenAIEmbedder(config=embedder_config),
            cross_encoder=GeminiRerankerClient(config=reranker_config),
        )

        await graphiti_instance.build_indices_and_constraints()
        return graphiti_instance


# ── Pydantic DTOs ──


class Message(BaseModel):
    content: str
    uuid: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: Optional[str] = None
    role_type: str = "user"
    role: Optional[str] = None
    timestamp: Optional[str] = None
    source_description: Optional[str] = None


class AddMessagesRequest(BaseModel):
    group_id: str
    messages: list[Message]


class SearchQuery(BaseModel):
    group_ids: list[str] = Field(default_factory=list)
    query: str
    max_facts: int = 10


class FactResult(BaseModel):
    uuid: str
    name: str
    fact: str
    valid_at: Optional[str] = None
    invalid_at: Optional[str] = None
    created_at: Optional[str] = None
    expired_at: Optional[str] = None


class SearchResults(BaseModel):
    facts: list[FactResult]


# ── FastAPI app ──


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: init graphiti
    await get_graphiti()
    yield
    # Shutdown: close driver
    if graphiti_instance is not None:
        await graphiti_instance.close()


app = FastAPI(title="Graphiti Server", lifespan=lifespan)


@app.exception_handler(Exception)
async def global_exception_handler(request, exc):
    return JSONResponse(
        status_code=500,
        content={"error": str(exc), "type": type(exc).__name__},
    )


@app.get("/healthcheck")
async def healthcheck():
    return {"status": "ok"}


# ── Ingest routes ──


@app.post("/messages")
async def add_messages(req: AddMessagesRequest):
    """Add episodes to the knowledge graph."""
    g = await get_graphiti()

    results = []
    for msg in req.messages:
        ts = (
            datetime.fromisoformat(msg.timestamp)
            if msg.timestamp
            else datetime.now(timezone.utc)
        )
        await g.add_episode(
            name=msg.name or f"message-{msg.uuid}",
            episode_body=msg.content,
            source_description=msg.source_description or f"group:{req.group_id}",
            reference_time=ts,
            group_id=req.group_id,
            uuid=msg.uuid,
        )
        results.append({"uuid": msg.uuid, "status": "ok"})

    return {"results": results}


@app.delete("/episode/{episode_uuid}")
async def delete_episode(episode_uuid: str):
    """Delete an episode by UUID."""
    g = await get_graphiti()
    await g.remove_episode(episode_uuid)
    return {"status": "ok"}


# ── Search routes ──


@app.post("/search")
async def search(req: SearchQuery):
    """Hybrid search: semantic + BM25 + graph traversal."""
    g = await get_graphiti()

    edges = await g.search(
        query=req.query,
        group_ids=req.group_ids if req.group_ids else None,
        num_results=req.max_facts,
    )

    facts = []
    for edge in edges:
        facts.append(
            FactResult(
                uuid=edge.uuid,
                name=edge.name if hasattr(edge, "name") else "",
                fact=edge.fact,
                valid_at=edge.valid_at.isoformat() if edge.valid_at else None,
                invalid_at=edge.invalid_at.isoformat() if edge.invalid_at else None,
                created_at=edge.created_at.isoformat() if hasattr(edge, "created_at") and edge.created_at else None,
                expired_at=edge.expired_at.isoformat() if hasattr(edge, "expired_at") and edge.expired_at else None,
            )
        )

    return SearchResults(facts=facts)


@app.get("/episodes/{group_id}")
async def get_episodes(group_id: str, last_n: int = 10):
    """Get recent episodes for a group."""
    g = await get_graphiti()
    last_n = min(last_n, 100)
    episodes = await g.retrieve_episodes(
        reference_time=datetime.now(timezone.utc),
        last_n=last_n,
        group_ids=[group_id],
    )

    return {
        "group_id": group_id,
        "episodes": [
            {
                "uuid": ep.uuid,
                "name": ep.name if hasattr(ep, "name") else "",
                "content": ep.content if hasattr(ep, "content") else "",
                "created_at": ep.created_at.isoformat() if hasattr(ep, "created_at") and ep.created_at else None,
            }
            for ep in episodes
        ],
    }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=config.SERVER_PORT)
