from fastapi import FastAPI, APIRouter, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient
import os
import logging
from pathlib import Path
from pydantic import BaseModel, Field
from typing import List, Dict, Optional
import uuid
from datetime import datetime
import json
import asyncio

ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / '.env')

# MongoDB connection
mongo_url = os.environ['MONGO_URL']
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ['DB_NAME']]

# Create the main app without a prefix
app = FastAPI()

# Create a router with the /api prefix
api_router = APIRouter(prefix="/api")

# WebRTC signaling and session management
class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, WebSocket] = {}
        self.sessions: Dict[str, Dict] = {}
        self.host_sessions: Dict[str, str] = {}  # session_id -> host_connection_id

    async def connect(self, websocket: WebSocket, connection_id: str):
        await websocket.accept()
        self.active_connections[connection_id] = websocket

    def disconnect(self, connection_id: str):
        if connection_id in self.active_connections:
            del self.active_connections[connection_id]
        # Clean up any sessions this connection was part of
        for session_id, session in list(self.sessions.items()):
            if session.get('host_id') == connection_id or connection_id in session.get('clients', []):
                del self.sessions[session_id]
                if session_id in self.host_sessions:
                    del self.host_sessions[session_id]

    async def send_personal_message(self, message: dict, connection_id: str):
        if connection_id in self.active_connections:
            websocket = self.active_connections[connection_id]
            await websocket.send_text(json.dumps(message))

    async def broadcast_to_session(self, message: dict, session_id: str, exclude_id: str = None):
        if session_id in self.sessions:
            session = self.sessions[session_id]
            all_connections = [session['host_id']] + session.get('clients', [])
            for connection_id in all_connections:
                if connection_id != exclude_id and connection_id in self.active_connections:
                    await self.send_personal_message(message, connection_id)

manager = ConnectionManager()

# Models for API
class AudioSession(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    host_id: str
    session_name: str
    created_at: datetime = Field(default_factory=datetime.utcnow)
    is_active: bool = True
    client_count: int = 0

class AudioSessionCreate(BaseModel):
    session_name: str

class SyncState(BaseModel):
    session_id: str
    playback_position: float  # in seconds
    is_playing: bool
    timestamp: float  # high-resolution timestamp
    bpm: Optional[float] = None
    current_track: Optional[str] = None

class ClientJoinRequest(BaseModel):
    session_id: str
    client_name: str

# API Routes
@api_router.get("/")
async def root():
    return {"message": "Music Sync Server Ready"}

@api_router.post("/sessions", response_model=AudioSession)
async def create_session(session_data: AudioSessionCreate):
    session = AudioSession(
        host_id="",  # Will be set when WebSocket connects
        session_name=session_data.session_name
    )
    await db.audio_sessions.insert_one(session.dict())
    return session

@api_router.get("/sessions", response_model=List[AudioSession])
async def get_active_sessions():
    sessions = await db.audio_sessions.find({"is_active": True}).to_list(100)
    return [AudioSession(**session) for session in sessions]

@api_router.get("/sessions/{session_id}")
async def get_session(session_id: str):
    session = await db.audio_sessions.find_one({"id": session_id})
    if session:
        return AudioSession(**session)
    return {"error": "Session not found"}

# WebSocket endpoint for real-time communication
@app.websocket("/ws/{connection_id}")
async def websocket_endpoint(websocket: WebSocket, connection_id: str):
    await manager.connect(websocket, connection_id)
    try:
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            message_type = message.get("type")
            
            if message_type == "host_create_session":
                session_id = message["session_id"]
                manager.sessions[session_id] = {
                    "host_id": connection_id,
                    "clients": [],
                    "session_name": message["session_name"]
                }
                manager.host_sessions[session_id] = connection_id
                await manager.send_personal_message({
                    "type": "session_created",
                    "session_id": session_id
                }, connection_id)
                
            elif message_type == "client_join_session":
                session_id = message["session_id"]
                if session_id in manager.sessions:
                    manager.sessions[session_id]["clients"].append(connection_id)
                    # Notify host about new client
                    await manager.send_personal_message({
                        "type": "client_joined",
                        "client_id": connection_id,
                        "client_name": message.get("client_name", "Unknown")
                    }, manager.sessions[session_id]["host_id"])
                    # Confirm join to client
                    await manager.send_personal_message({
                        "type": "joined_session",
                        "session_id": session_id
                    }, connection_id)
                else:
                    await manager.send_personal_message({
                        "type": "error",
                        "message": "Session not found"
                    }, connection_id)
                    
            elif message_type == "webrtc_offer":
                target_id = message["target_id"]
                await manager.send_personal_message({
                    "type": "webrtc_offer",
                    "offer": message["offer"],
                    "from_id": connection_id
                }, target_id)
                
            elif message_type == "webrtc_answer":
                target_id = message["target_id"]
                await manager.send_personal_message({
                    "type": "webrtc_answer",
                    "answer": message["answer"],
                    "from_id": connection_id
                }, target_id)
                
            elif message_type == "webrtc_ice_candidate":
                target_id = message["target_id"]
                await manager.send_personal_message({
                    "type": "webrtc_ice_candidate",
                    "candidate": message["candidate"],
                    "from_id": connection_id
                }, target_id)
                
            elif message_type == "sync_state":
                session_id = message["session_id"]
                # Broadcast sync state to all clients in session
                await manager.broadcast_to_session({
                    "type": "sync_state",
                    "playback_position": message["playback_position"],
                    "is_playing": message["is_playing"],
                    "timestamp": message["timestamp"],
                    "bpm": message.get("bpm"),
                    "current_track": message.get("current_track")
                }, session_id, exclude_id=connection_id)
                
            elif message_type == "audio_chunk":
                session_id = message["session_id"]
                # Relay audio chunk to all clients
                await manager.broadcast_to_session({
                    "type": "audio_chunk",
                    "audio_data": message["audio_data"],
                    "timestamp": message["timestamp"],
                    "chunk_id": message["chunk_id"]
                }, session_id, exclude_id=connection_id)
                
    except WebSocketDisconnect:
        manager.disconnect(connection_id)

# Include the router in the main app
app.include_router(api_router)

app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)

@app.on_event("shutdown")
async def shutdown_db_client():
    client.close()
