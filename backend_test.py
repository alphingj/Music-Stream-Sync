#!/usr/bin/env python3
import requests
import websockets
import asyncio
import json
import uuid
import os
import sys
from dotenv import load_dotenv
import time

# Load environment variables from frontend/.env
load_dotenv("/app/frontend/.env")

# Get the backend URL from environment variables
BACKEND_URL = os.environ.get("REACT_APP_BACKEND_URL")
if not BACKEND_URL:
    print("Error: REACT_APP_BACKEND_URL not found in environment variables")
    sys.exit(1)

# API endpoints
API_BASE_URL = f"{BACKEND_URL}/api"
WS_BASE_URL = BACKEND_URL.replace("https://", "wss://").replace("http://", "ws://")

print(f"Testing backend at: {BACKEND_URL}")
print(f"API Base URL: {API_BASE_URL}")
print(f"WebSocket Base URL: {WS_BASE_URL}")

# Test results tracking
test_results = {
    "passed": 0,
    "failed": 0,
    "tests": []
}

def log_test(name, passed, message=""):
    """Log test results"""
    status = "PASSED" if passed else "FAILED"
    print(f"[{status}] {name}")
    if message:
        print(f"  {message}")
    
    test_results["tests"].append({
        "name": name,
        "passed": passed,
        "message": message
    })
    
    if passed:
        test_results["passed"] += 1
    else:
        test_results["failed"] += 1

def test_api_health():
    """Test the API health endpoint"""
    try:
        response = requests.get(f"{API_BASE_URL}/")
        if response.status_code == 200:
            data = response.json()
            if data.get("message") == "Music Sync Server Ready":
                log_test("API Health Check", True)
                return True
            else:
                log_test("API Health Check", False, f"Unexpected response: {data}")
                return False
        else:
            log_test("API Health Check", False, f"Status code: {response.status_code}")
            return False
    except Exception as e:
        log_test("API Health Check", False, f"Exception: {str(e)}")
        return False

def test_create_session():
    """Test creating a new audio session"""
    try:
        session_name = f"Test Session {uuid.uuid4()}"
        response = requests.post(
            f"{API_BASE_URL}/sessions", 
            json={"session_name": session_name}
        )
        
        if response.status_code == 200:
            data = response.json()
            if data.get("session_name") == session_name and "id" in data:
                log_test("Create Session API", True)
                return data
            else:
                log_test("Create Session API", False, f"Unexpected response: {data}")
                return None
        else:
            log_test("Create Session API", False, f"Status code: {response.status_code}")
            return None
    except Exception as e:
        log_test("Create Session API", False, f"Exception: {str(e)}")
        return None

def test_get_sessions():
    """Test getting all active sessions"""
    try:
        response = requests.get(f"{API_BASE_URL}/sessions")
        
        if response.status_code == 200:
            data = response.json()
            if isinstance(data, list):
                log_test("Get Sessions API", True)
                return data
            else:
                log_test("Get Sessions API", False, f"Unexpected response format: {data}")
                return None
        else:
            log_test("Get Sessions API", False, f"Status code: {response.status_code}")
            return None
    except Exception as e:
        log_test("Get Sessions API", False, f"Exception: {str(e)}")
        return None

def test_get_session_by_id(session_id):
    """Test getting a specific session by ID"""
    try:
        response = requests.get(f"{API_BASE_URL}/sessions/{session_id}")
        
        if response.status_code == 200:
            data = response.json()
            if data.get("id") == session_id:
                log_test("Get Session by ID API", True)
                return data
            else:
                log_test("Get Session by ID API", False, f"Unexpected response: {data}")
                return None
        else:
            log_test("Get Session by ID API", False, f"Status code: {response.status_code}")
            return None
    except Exception as e:
        log_test("Get Session by ID API", False, f"Exception: {str(e)}")
        return None

async def test_websocket_connection(connection_id):
    """Test establishing a WebSocket connection"""
    try:
        ws_url = f"{WS_BASE_URL}/ws/{connection_id}"
        async with websockets.connect(ws_url) as websocket:
            log_test("WebSocket Connection", True)
            return websocket
    except Exception as e:
        log_test("WebSocket Connection", False, f"Exception: {str(e)}")
        return None

async def test_host_create_session(connection_id, session_id, session_name):
    """Test host creating a session via WebSocket"""
    try:
        ws_url = f"{WS_BASE_URL}/ws/{connection_id}"
        async with websockets.connect(ws_url) as websocket:
            # Send host_create_session message
            message = {
                "type": "host_create_session",
                "session_id": session_id,
                "session_name": session_name
            }
            await websocket.send(json.dumps(message))
            
            # Wait for response
            response = await asyncio.wait_for(websocket.recv(), timeout=5)
            data = json.loads(response)
            
            if data.get("type") == "session_created" and data.get("session_id") == session_id:
                log_test("Host Create Session via WebSocket", True)
                return True
            else:
                log_test("Host Create Session via WebSocket", False, f"Unexpected response: {data}")
                return False
    except Exception as e:
        log_test("Host Create Session via WebSocket", False, f"Exception: {str(e)}")
        return False

async def test_client_join_session(host_connection_id, client_connection_id, session_id):
    """Test client joining a session via WebSocket"""
    host_ws = None
    client_ws = None
    
    try:
        # Connect host
        host_ws_url = f"{WS_BASE_URL}/ws/{host_connection_id}"
        host_ws = await websockets.connect(host_ws_url)
        
        # Host creates session
        host_message = {
            "type": "host_create_session",
            "session_id": session_id,
            "session_name": "Test Session"
        }
        await host_ws.send(json.dumps(host_message))
        
        # Wait for host confirmation
        host_response = await asyncio.wait_for(host_ws.recv(), timeout=5)
        host_data = json.loads(host_response)
        
        if not (host_data.get("type") == "session_created" and host_data.get("session_id") == session_id):
            log_test("Client Join Session - Host Setup", False, f"Host setup failed: {host_data}")
            return False
        
        # Connect client
        client_ws_url = f"{WS_BASE_URL}/ws/{client_connection_id}"
        client_ws = await websockets.connect(client_ws_url)
        
        # Client joins session
        client_message = {
            "type": "client_join_session",
            "session_id": session_id,
            "client_name": "Test Client"
        }
        await client_ws.send(json.dumps(client_message))
        
        # Wait for client confirmation
        client_response = await asyncio.wait_for(client_ws.recv(), timeout=5)
        client_data = json.loads(client_response)
        
        client_success = client_data.get("type") == "joined_session" and client_data.get("session_id") == session_id
        
        # Wait for host notification about client
        host_notification = await asyncio.wait_for(host_ws.recv(), timeout=5)
        host_notif_data = json.loads(host_notification)
        
        host_notified = host_notif_data.get("type") == "client_joined" and host_notif_data.get("client_id") == client_connection_id
        
        if client_success and host_notified:
            log_test("Client Join Session via WebSocket", True)
            return True
        else:
            log_test("Client Join Session via WebSocket", False, 
                    f"Client response: {client_data}, Host notification: {host_notif_data}")
            return False
            
    except Exception as e:
        log_test("Client Join Session via WebSocket", False, f"Exception: {str(e)}")
        return False
    finally:
        # Clean up connections
        if host_ws:
            await host_ws.close()
        if client_ws:
            await client_ws.close()

async def test_webrtc_signaling(host_connection_id, client_connection_id):
    """Test WebRTC signaling message relay"""
    host_ws = None
    client_ws = None
    
    try:
        # Connect host and client
        host_ws_url = f"{WS_BASE_URL}/ws/{host_connection_id}"
        client_ws_url = f"{WS_BASE_URL}/ws/{client_connection_id}"
        
        host_ws = await websockets.connect(host_ws_url)
        client_ws = await websockets.connect(client_ws_url)
        
        # Host sends offer to client
        offer_message = {
            "type": "webrtc_offer",
            "target_id": client_connection_id,
            "offer": {"sdp": "test_sdp", "type": "offer"}
        }
        await host_ws.send(json.dumps(offer_message))
        
        # Client receives offer
        client_response = await asyncio.wait_for(client_ws.recv(), timeout=5)
        client_data = json.loads(client_response)
        
        offer_received = (
            client_data.get("type") == "webrtc_offer" and 
            client_data.get("from_id") == host_connection_id and
            client_data.get("offer") == {"sdp": "test_sdp", "type": "offer"}
        )
        
        # Client sends answer to host
        answer_message = {
            "type": "webrtc_answer",
            "target_id": host_connection_id,
            "answer": {"sdp": "test_answer_sdp", "type": "answer"}
        }
        await client_ws.send(json.dumps(answer_message))
        
        # Host receives answer
        host_response = await asyncio.wait_for(host_ws.recv(), timeout=5)
        host_data = json.loads(host_response)
        
        answer_received = (
            host_data.get("type") == "webrtc_answer" and 
            host_data.get("from_id") == client_connection_id and
            host_data.get("answer") == {"sdp": "test_answer_sdp", "type": "answer"}
        )
        
        # Host sends ICE candidate to client
        ice_message = {
            "type": "webrtc_ice_candidate",
            "target_id": client_connection_id,
            "candidate": {"candidate": "test_ice_candidate", "sdpMid": "0", "sdpMLineIndex": 0}
        }
        await host_ws.send(json.dumps(ice_message))
        
        # Client receives ICE candidate
        ice_response = await asyncio.wait_for(client_ws.recv(), timeout=5)
        ice_data = json.loads(ice_response)
        
        ice_received = (
            ice_data.get("type") == "webrtc_ice_candidate" and 
            ice_data.get("from_id") == host_connection_id and
            ice_data.get("candidate") == {"candidate": "test_ice_candidate", "sdpMid": "0", "sdpMLineIndex": 0}
        )
        
        if offer_received and answer_received and ice_received:
            log_test("WebRTC Signaling Relay", True)
            return True
        else:
            log_test("WebRTC Signaling Relay", False, 
                    f"Offer received: {offer_received}, Answer received: {answer_received}, ICE received: {ice_received}")
            return False
            
    except Exception as e:
        log_test("WebRTC Signaling Relay", False, f"Exception: {str(e)}")
        return False
    finally:
        # Clean up connections
        if host_ws:
            await host_ws.close()
        if client_ws:
            await client_ws.close()

async def test_sync_state_broadcasting(host_connection_id, client_connection_id, session_id):
    """Test sync state broadcasting from host to client"""
    host_ws = None
    client_ws = None
    
    try:
        # Connect host
        host_ws_url = f"{WS_BASE_URL}/ws/{host_connection_id}"
        host_ws = await websockets.connect(host_ws_url)
        
        # Host creates session
        host_message = {
            "type": "host_create_session",
            "session_id": session_id,
            "session_name": "Test Session"
        }
        await host_ws.send(json.dumps(host_message))
        await asyncio.wait_for(host_ws.recv(), timeout=5)  # Wait for session_created confirmation
        
        # Connect client
        client_ws_url = f"{WS_BASE_URL}/ws/{client_connection_id}"
        client_ws = await websockets.connect(client_ws_url)
        
        # Client joins session
        client_message = {
            "type": "client_join_session",
            "session_id": session_id,
            "client_name": "Test Client"
        }
        await client_ws.send(json.dumps(client_message))
        await asyncio.wait_for(client_ws.recv(), timeout=5)  # Wait for joined_session confirmation
        await asyncio.wait_for(host_ws.recv(), timeout=5)  # Wait for client_joined notification
        
        # Host sends sync state
        sync_state = {
            "type": "sync_state",
            "session_id": session_id,
            "playback_position": 10.5,
            "is_playing": True,
            "timestamp": time.time(),
            "bpm": 120,
            "current_track": "test_track.mp3"
        }
        await host_ws.send(json.dumps(sync_state))
        
        # Client receives sync state
        client_response = await asyncio.wait_for(client_ws.recv(), timeout=5)
        client_data = json.loads(client_response)
        
        sync_received = (
            client_data.get("type") == "sync_state" and 
            client_data.get("playback_position") == 10.5 and
            client_data.get("is_playing") == True and
            client_data.get("bpm") == 120 and
            client_data.get("current_track") == "test_track.mp3"
        )
        
        if sync_received:
            log_test("Sync State Broadcasting", True)
            return True
        else:
            log_test("Sync State Broadcasting", False, f"Unexpected response: {client_data}")
            return False
            
    except Exception as e:
        log_test("Sync State Broadcasting", False, f"Exception: {str(e)}")
        return False
    finally:
        # Clean up connections
        if host_ws:
            await host_ws.close()
        if client_ws:
            await client_ws.close()

async def test_audio_chunk_relay(host_connection_id, client_connection_id, session_id):
    """Test audio chunk relay from host to client"""
    host_ws = None
    client_ws = None
    
    try:
        # Connect host
        host_ws_url = f"{WS_BASE_URL}/ws/{host_connection_id}"
        host_ws = await websockets.connect(host_ws_url)
        
        # Host creates session
        host_message = {
            "type": "host_create_session",
            "session_id": session_id,
            "session_name": "Test Session"
        }
        await host_ws.send(json.dumps(host_message))
        await asyncio.wait_for(host_ws.recv(), timeout=5)  # Wait for session_created confirmation
        
        # Connect client
        client_ws_url = f"{WS_BASE_URL}/ws/{client_connection_id}"
        client_ws = await websockets.connect(client_ws_url)
        
        # Client joins session
        client_message = {
            "type": "client_join_session",
            "session_id": session_id,
            "client_name": "Test Client"
        }
        await client_ws.send(json.dumps(client_message))
        await asyncio.wait_for(client_ws.recv(), timeout=5)  # Wait for joined_session confirmation
        await asyncio.wait_for(host_ws.recv(), timeout=5)  # Wait for client_joined notification
        
        # Host sends audio chunk
        audio_chunk = {
            "type": "audio_chunk",
            "session_id": session_id,
            "audio_data": "base64_encoded_audio_data",
            "timestamp": time.time(),
            "chunk_id": "chunk_1"
        }
        await host_ws.send(json.dumps(audio_chunk))
        
        # Client receives audio chunk
        client_response = await asyncio.wait_for(client_ws.recv(), timeout=5)
        client_data = json.loads(client_response)
        
        chunk_received = (
            client_data.get("type") == "audio_chunk" and 
            client_data.get("audio_data") == "base64_encoded_audio_data" and
            client_data.get("chunk_id") == "chunk_1"
        )
        
        if chunk_received:
            log_test("Audio Chunk Relay", True)
            return True
        else:
            log_test("Audio Chunk Relay", False, f"Unexpected response: {client_data}")
            return False
            
    except Exception as e:
        log_test("Audio Chunk Relay", False, f"Exception: {str(e)}")
        return False
    finally:
        # Clean up connections
        if host_ws:
            await host_ws.close()
        if client_ws:
            await client_ws.close()

async def test_connection_cleanup(host_connection_id, client_connection_id, session_id):
    """Test connection cleanup when WebSocket disconnects"""
    host_ws = None
    client_ws = None
    
    try:
        # Connect host
        host_ws_url = f"{WS_BASE_URL}/ws/{host_connection_id}"
        host_ws = await websockets.connect(host_ws_url)
        
        # Host creates session
        host_message = {
            "type": "host_create_session",
            "session_id": session_id,
            "session_name": "Test Session"
        }
        await host_ws.send(json.dumps(host_message))
        await asyncio.wait_for(host_ws.recv(), timeout=5)  # Wait for session_created confirmation
        
        # Connect client
        client_ws_url = f"{WS_BASE_URL}/ws/{client_connection_id}"
        client_ws = await websockets.connect(client_ws_url)
        
        # Client joins session
        client_message = {
            "type": "client_join_session",
            "session_id": session_id,
            "client_name": "Test Client"
        }
        await client_ws.send(json.dumps(client_message))
        await asyncio.wait_for(client_ws.recv(), timeout=5)  # Wait for joined_session confirmation
        await asyncio.wait_for(host_ws.recv(), timeout=5)  # Wait for client_joined notification
        
        # Close client connection
        await client_ws.close()
        client_ws = None
        
        # Wait a moment for cleanup to occur
        await asyncio.sleep(1)
        
        # Connect a new client
        new_client_id = str(uuid.uuid4())
        new_client_ws_url = f"{WS_BASE_URL}/ws/{new_client_id}"
        new_client_ws = await websockets.connect(new_client_ws_url)
        
        # New client tries to join session
        new_client_message = {
            "type": "client_join_session",
            "session_id": session_id,
            "client_name": "New Test Client"
        }
        await new_client_ws.send(json.dumps(new_client_message))
        
        # Wait for joined_session confirmation
        new_client_response = await asyncio.wait_for(new_client_ws.recv(), timeout=5)
        new_client_data = json.loads(new_client_response)
        
        # Host should receive notification about new client
        host_notification = await asyncio.wait_for(host_ws.recv(), timeout=5)
        host_notif_data = json.loads(host_notification)
        
        cleanup_successful = (
            new_client_data.get("type") == "joined_session" and
            host_notif_data.get("type") == "client_joined" and
            host_notif_data.get("client_id") == new_client_id
        )
        
        if cleanup_successful:
            log_test("Connection Cleanup", True)
            return True
        else:
            log_test("Connection Cleanup", False, 
                    f"New client response: {new_client_data}, Host notification: {host_notif_data}")
            return False
            
    except Exception as e:
        log_test("Connection Cleanup", False, f"Exception: {str(e)}")
        return False
    finally:
        # Clean up connections
        if host_ws:
            await host_ws.close()
        if client_ws:
            await client_ws.close()

async def run_websocket_tests():
    """Run all WebSocket tests"""
    # Generate unique IDs for testing
    host_id = str(uuid.uuid4())
    client_id = str(uuid.uuid4())
    session_id = str(uuid.uuid4())
    
    # Run WebSocket tests
    await test_host_create_session(host_id, session_id, "Test Session")
    await test_client_join_session(str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4()))
    await test_webrtc_signaling(str(uuid.uuid4()), str(uuid.uuid4()))
    await test_sync_state_broadcasting(str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4()))
    await test_audio_chunk_relay(str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4()))
    await test_connection_cleanup(str(uuid.uuid4()), str(uuid.uuid4()), str(uuid.uuid4()))

async def main():
    """Main test function"""
    print("=== Testing Music Sync Backend ===")
    
    # Test REST API endpoints
    test_api_health()
    session = test_create_session()
    if session:
        test_get_sessions()
        test_get_session_by_id(session["id"])
    
    # Run WebSocket tests
    await run_websocket_tests()
    
    # Print summary
    print("\n=== Test Summary ===")
    print(f"Total tests: {test_results['passed'] + test_results['failed']}")
    print(f"Passed: {test_results['passed']}")
    print(f"Failed: {test_results['failed']}")
    
    # Print failed tests
    if test_results["failed"] > 0:
        print("\nFailed Tests:")
        for test in test_results["tests"]:
            if not test["passed"]:
                print(f"- {test['name']}: {test['message']}")

if __name__ == "__main__":
    asyncio.run(main())