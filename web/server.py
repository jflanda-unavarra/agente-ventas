#!/usr/bin/env python3
"""Backend web del agente de ventas (FastAPI + SSE). Reutiliza agente_ventas.py."""

import asyncio
import json
import sys
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from copilot import CopilotClient  # noqa: E402
from copilot.session import PermissionHandler  # noqa: E402
from copilot.session_events import SessionEventType  # noqa: E402
from fastapi import FastAPI, HTTPException  # noqa: E402
from fastapi.responses import FileResponse, StreamingResponse  # noqa: E402
from fastapi.staticfiles import StaticFiles  # noqa: E402
from pydantic import BaseModel  # noqa: E402

import agente_ventas as core  # noqa: E402

MODEL = "deepseek/deepseek-v4.1-flash"
STATIC = Path(__file__).resolve().parent / "static"


class Conversation:
    def __init__(self, session):
        self.session = session
        self.queue: asyncio.Queue = asyncio.Queue()
        self.lock = asyncio.Lock()


state: dict = {"client": None, "conversations": {}}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    if not core.DB_PATH.is_file():
        raise FileNotFoundError(f"No existe la base de datos: {core.DB_PATH}")
    core.get_api_key()  # falla pronto si falta la clave
    client = CopilotClient(
        mode="empty",
        working_directory=str(ROOT),
        base_directory=str(ROOT / ".copilot-state"),
    )
    await client.start()
    state["client"] = client
    try:
        yield
    finally:
        await client.stop()


app = FastAPI(title="Agente de ventas", lifespan=lifespan)


async def new_conversation() -> Conversation:
    session = await state["client"].create_session(
        on_permission_request=PermissionHandler.approve_all,
        model=MODEL,
        provider={
            "type": "openai",
            "base_url": "https://openrouter.ai/api/v1",
            "wire_api": "responses",
            "api_key": core.get_api_key(),
        },
        streaming=True,
        tools=[core.query_sales],
        available_tools=["custom:query_sales"],
        system_message={"mode": "replace", "content": core.SYSTEM_PROMPT},
    )
    conv = Conversation(session)

    def on_event(event):
        if event.type == SessionEventType.ASSISTANT_MESSAGE_DELTA:
            conv.queue.put_nowait(("delta", event.data.delta_content or ""))
        elif event.type == SessionEventType.SESSION_ERROR:
            conv.queue.put_nowait(("error", str(event.data)))

    session.on(on_event)
    return conv


class ChatRequest(BaseModel):
    message: str
    conversation_id: str | None = None


def sse(event: str, data) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.post("/api/chat")
async def chat(req: ChatRequest):
    message = req.message.strip()
    if not message:
        raise HTTPException(400, "Mensaje vacío")

    conv_id = req.conversation_id
    conv = state["conversations"].get(conv_id) if conv_id else None
    if conv is None:
        conv_id = uuid.uuid4().hex
        conv = await new_conversation()
        state["conversations"][conv_id] = conv

    async def stream():
        async with conv.lock:
            while not conv.queue.empty():  # descarta restos de turnos anteriores
                conv.queue.get_nowait()
            yield sse("start", {"conversation_id": conv_id})
            task = asyncio.create_task(conv.session.send_and_wait(message))
            try:
                while True:
                    getter = asyncio.create_task(conv.queue.get())
                    done, _ = await asyncio.wait(
                        {getter, task}, return_when=asyncio.FIRST_COMPLETED
                    )
                    if getter in done:
                        kind, payload = getter.result()
                        yield sse(kind, payload)
                    else:
                        getter.cancel()
                    if task in done:
                        while not conv.queue.empty():
                            kind, payload = conv.queue.get_nowait()
                            yield sse(kind, payload)
                        exc = task.exception()
                        if exc:
                            yield sse("error", str(exc))
                        yield sse("done", {})
                        return
            finally:
                if not task.done():
                    task.cancel()

    return StreamingResponse(
        stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.delete("/api/chat/{conversation_id}")
async def reset(conversation_id: str):
    state["conversations"].pop(conversation_id, None)
    return {"ok": True}


@app.get("/")
async def index():
    return FileResponse(STATIC / "index.html")


app.mount("/static", StaticFiles(directory=STATIC), name="static")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)
