"""Graphiti server configuration — FalkorDB + Gemini 2.0 Flash."""

import os

# FalkorDB (Redis-compatible graph DB)
FALKORDB_HOST = os.getenv("FALKORDB_HOST", "falkordb")
FALKORDB_PORT = int(os.getenv("FALKORDB_PORT", "6379"))
FALKORDB_USERNAME = os.getenv("FALKORDB_USERNAME", "")
FALKORDB_PASSWORD = os.getenv("FALKORDB_PASSWORD", "")

# LLM — Gemini 2.0 Flash via native google-genai SDK
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
LLM_MODEL = os.getenv("LLM_MODEL", "gemini-2.5-flash")
EMBEDDER_MODEL = os.getenv("EMBEDDER_MODEL", "gemini-embedding-001")

# Server
SERVER_PORT = int(os.getenv("GRAPHITI_PORT", "3200"))

# Validate required config
if not GEMINI_API_KEY:
    raise ValueError("GEMINI_API_KEY environment variable is required")
