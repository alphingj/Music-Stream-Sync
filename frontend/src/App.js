import React, { useState, useEffect, useRef } from 'react';
import './App.css';

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL;
const API = `${BACKEND_URL}/api`;
const WS_URL = BACKEND_URL.replace(/^http/, 'ws');

// Audio Synchronization Engine
class AudioSyncEngine {
  constructor() {
    this.audioContext = null;
    this.audioBuffer = null;
    this.sourceNode = null;
    this.gainNode = null;
    this.startTime = 0;
    this.pauseTime = 0;
    this.isPlaying = false;
    this.clockOffset = 0; // For synchronization with host
    this.jitterBuffer = [];
    this.targetBufferSize = 5; // 5 chunks
  }

  async initialize() {
    try {
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      this.gainNode = this.audioContext.createGain();
      this.gainNode.connect(this.audioContext.destination);
      return true;
    } catch (error) {
      console.error('Failed to initialize audio context:', error);
      return false;
    }
  }

  async loadAudioFile(file) {
    try {
      const arrayBuffer = await file.arrayBuffer();
      this.audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
      return true;
    } catch (error) {
      console.error('Failed to load audio file:', error);
      return false;
    }
  }

  play(startOffset = 0) {
    if (!this.audioBuffer || !this.audioContext) return false;

    this.stop(); // Stop any existing playback
    
    this.sourceNode = this.audioContext.createBufferSource();
    this.sourceNode.buffer = this.audioBuffer;
    this.sourceNode.connect(this.gainNode);
    
    const now = this.audioContext.currentTime;
    this.startTime = now - startOffset;
    this.sourceNode.start(0, startOffset);
    this.isPlaying = true;
    
    return true;
  }

  pause() {
    if (this.sourceNode && this.isPlaying) {
      this.pauseTime = this.audioContext.currentTime - this.startTime;
      this.sourceNode.stop();
      this.isPlaying = false;
    }
  }

  stop() {
    if (this.sourceNode) {
      this.sourceNode.stop();
      this.sourceNode = null;
    }
    this.isPlaying = false;
    this.startTime = 0;
    this.pauseTime = 0;
  }

  getCurrentTime() {
    if (!this.isPlaying) return this.pauseTime;
    return this.audioContext.currentTime - this.startTime;
  }

  setVolume(volume) {
    if (this.gainNode) {
      this.gainNode.gain.setValueAtTime(volume, this.audioContext.currentTime);
    }
  }

  // Synchronization methods
  syncWithHost(hostTime, hostTimestamp) {
    const now = performance.now();
    const networkLatency = (now - hostTimestamp) / 2; // Rough estimate
    const targetTime = hostTime + networkLatency / 1000;
    
    if (Math.abs(this.getCurrentTime() - targetTime) > 0.05) { // 50ms threshold
      this.seek(targetTime);
    }
  }

  seek(time) {
    if (this.isPlaying) {
      this.play(time);
    } else {
      this.pauseTime = time;
    }
  }
}

// WebRTC P2P Connection Manager
class P2PManager {
  constructor(onMessage, onStateChange) {
    this.peerConnection = null;
    this.dataChannel = null;
    this.onMessage = onMessage;
    this.onStateChange = onStateChange;
    this.isHost = false;
    this.connectionState = 'disconnected';
  }

  async initialize(isHost = false) {
    this.isHost = isHost;
    
    const configuration = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
      ]
    };

    this.peerConnection = new RTCPeerConnection(configuration);

    if (isHost) {
      // Host creates data channel
      this.dataChannel = this.peerConnection.createDataChannel('audio-sync', {
        ordered: true,
        maxRetransmits: 0 // Low latency priority
      });
      this.setupDataChannel();
    } else {
      // Client waits for data channel
      this.peerConnection.ondatachannel = (event) => {
        this.dataChannel = event.channel;
        this.setupDataChannel();
      };
    }

    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.onMessage('ice-candidate', event.candidate);
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      this.connectionState = this.peerConnection.connectionState;
      this.onStateChange(this.connectionState);
    };
  }

  setupDataChannel() {
    this.dataChannel.onopen = () => {
      console.log('Data channel opened');
      this.onStateChange('connected');
    };

    this.dataChannel.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.onMessage('data', data);
      } catch (error) {
        console.error('Failed to parse data channel message:', error);
      }
    };

    this.dataChannel.onclose = () => {
      console.log('Data channel closed');
      this.onStateChange('disconnected');
    };
  }

  async createOffer() {
    if (!this.peerConnection) return null;
    
    const offer = await this.peerConnection.createOffer();
    await this.peerConnection.setLocalDescription(offer);
    return offer;
  }

  async createAnswer(offer) {
    if (!this.peerConnection) return null;
    
    await this.peerConnection.setRemoteDescription(offer);
    const answer = await this.peerConnection.createAnswer();
    await this.peerConnection.setLocalDescription(answer);
    return answer;
  }

  async handleAnswer(answer) {
    if (this.peerConnection) {
      await this.peerConnection.setRemoteDescription(answer);
    }
  }

  async addIceCandidate(candidate) {
    if (this.peerConnection) {
      await this.peerConnection.addIceCandidate(candidate);
    }
  }

  sendData(data) {
    if (this.dataChannel && this.dataChannel.readyState === 'open') {
      this.dataChannel.send(JSON.stringify(data));
    }
  }

  close() {
    if (this.dataChannel) {
      this.dataChannel.close();
    }
    if (this.peerConnection) {
      this.peerConnection.close();
    }
  }
}

// Main App Component
function App() {
  const [mode, setMode] = useState('selector'); // 'selector', 'host', 'client'
  const [connectionState, setConnectionState] = useState('disconnected');
  const [sessionId, setSessionId] = useState('');
  const [sessionName, setSessionName] = useState('');
  const [audioFile, setAudioFile] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.8);
  const [connectedClients, setConnectedClients] = useState([]);
  const [availableSessions, setAvailableSessions] = useState([]);

  const audioEngine = useRef(new AudioSyncEngine());
  const p2pManager = useRef(null);
  const wsConnection = useRef(null);
  const syncInterval = useRef(null);
  const connectionId = useRef(Math.random().toString(36).substr(2, 9));

  // Initialize audio engine
  useEffect(() => {
    audioEngine.current.initialize();
  }, []);

  // WebSocket connection management
  useEffect(() => {
    if (mode !== 'selector') {
      connectWebSocket();
    }
    return () => {
      if (wsConnection.current) {
        wsConnection.current.close();
      }
    };
  }, [mode]);

  // Audio time tracking
  useEffect(() => {
    if (mode === 'host' && isPlaying) {
      const interval = setInterval(() => {
        const time = audioEngine.current.getCurrentTime();
        setCurrentTime(time);
        
        // Send sync state to clients
        if (p2pManager.current) {
          p2pManager.current.sendData({
            type: 'sync_state',
            playback_position: time,
            is_playing: isPlaying,
            timestamp: performance.now()
          });
        }
      }, 100); // Update every 100ms

      return () => clearInterval(interval);
    }
  }, [isPlaying, mode]);

  const connectWebSocket = () => {
    const ws = new WebSocket(`${WS_URL}/ws/${connectionId.current}`);
    
    ws.onopen = () => {
      console.log('WebSocket connected');
      wsConnection.current = ws;
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      handleWebSocketMessage(message);
    };

    ws.onclose = () => {
      console.log('WebSocket disconnected');
      wsConnection.current = null;
    };
  };

  const handleWebSocketMessage = (message) => {
    switch (message.type) {
      case 'session_created':
        setSessionId(message.session_id);
        initializeP2P(true);
        break;
        
      case 'client_joined':
        setConnectedClients(prev => [...prev, {
          id: message.client_id,
          name: message.client_name
        }]);
        break;
        
      case 'joined_session':
        setSessionId(message.session_id);
        initializeP2P(false);
        break;
        
      case 'webrtc_offer':
        handleWebRTCOffer(message.offer, message.from_id);
        break;
        
      case 'webrtc_answer':
        handleWebRTCAnswer(message.answer);
        break;
        
      case 'webrtc_ice_candidate':
        handleWebRTCIceCandidate(message.candidate);
        break;
        
      case 'sync_state':
        if (mode === 'client') {
          audioEngine.current.syncWithHost(
            message.playback_position,
            message.timestamp
          );
          setCurrentTime(message.playback_position);
          setIsPlaying(message.is_playing);
        }
        break;
    }
  };

  const initializeP2P = async (isHost) => {
    p2pManager.current = new P2PManager(
      (type, data) => {
        if (type === 'ice-candidate') {
          sendWebSocketMessage({
            type: 'webrtc_ice_candidate',
            candidate: data,
            target_id: 'broadcast' // Send to all in session
          });
        } else if (type === 'data') {
          handleP2PData(data);
        }
      },
      (state) => {
        setConnectionState(state);
      }
    );

    await p2pManager.current.initialize(isHost);

    if (isHost) {
      const offer = await p2pManager.current.createOffer();
      sendWebSocketMessage({
        type: 'webrtc_offer',
        offer: offer,
        target_id: 'broadcast'
      });
    }
  };

  const handleWebRTCOffer = async (offer, fromId) => {
    if (p2pManager.current && mode === 'client') {
      const answer = await p2pManager.current.createAnswer(offer);
      sendWebSocketMessage({
        type: 'webrtc_answer',
        answer: answer,
        target_id: fromId
      });
    }
  };

  const handleWebRTCAnswer = async (answer) => {
    if (p2pManager.current) {
      await p2pManager.current.handleAnswer(answer);
    }
  };

  const handleWebRTCIceCandidate = async (candidate) => {
    if (p2pManager.current) {
      await p2pManager.current.addIceCandidate(candidate);
    }
  };

  const handleP2PData = (data) => {
    switch (data.type) {
      case 'sync_state':
        if (mode === 'client') {
          audioEngine.current.syncWithHost(
            data.playback_position,
            data.timestamp
          );
          setCurrentTime(data.playback_position);
          setIsPlaying(data.is_playing);
        }
        break;
        
      case 'audio_chunk':
        // Handle audio streaming (placeholder for future implementation)
        console.log('Received audio chunk:', data.chunk_id);
        break;
    }
  };

  const sendWebSocketMessage = (message) => {
    if (wsConnection.current && wsConnection.current.readyState === WebSocket.OPEN) {
      wsConnection.current.send(JSON.stringify(message));
    }
  };

  const createSession = () => {
    if (!sessionName.trim()) {
      alert('Please enter a session name');
      return;
    }
    
    const newSessionId = Math.random().toString(36).substr(2, 9);
    sendWebSocketMessage({
      type: 'host_create_session',
      session_id: newSessionId,
      session_name: sessionName
    });
    setMode('host');
  };

  const joinSession = (sessionId) => {
    sendWebSocketMessage({
      type: 'client_join_session',
      session_id: sessionId,
      client_name: 'Client ' + connectionId.current.substr(0, 4)
    });
    setMode('client');
  };

  const handleFileUpload = async (event) => {
    const file = event.target.files[0];
    if (file && file.type.startsWith('audio/')) {
      setAudioFile(file);
      const success = await audioEngine.current.loadAudioFile(file);
      if (success) {
        setDuration(audioEngine.current.audioBuffer.duration);
      }
    }
  };

  const togglePlayback = () => {
    if (mode !== 'host') return;
    
    if (isPlaying) {
      audioEngine.current.pause();
      setIsPlaying(false);
    } else {
      const success = audioEngine.current.play(currentTime);
      if (success) {
        setIsPlaying(true);
      }
    }
  };

  const handleVolumeChange = (newVolume) => {
    setVolume(newVolume);
    audioEngine.current.setVolume(newVolume);
  };

  const formatTime = (seconds) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  // Mode Selector UI
  if (mode === 'selector') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-900 via-blue-900 to-indigo-900 flex items-center justify-center p-4">
        <div className="bg-white/10 backdrop-blur-lg rounded-3xl p-8 max-w-md w-full border border-white/20 shadow-2xl">
          <div className="text-center mb-8">
            <h1 className="text-4xl font-bold text-white mb-2">🎵 Music Sync</h1>
            <p className="text-gray-300">Real-time music synchronization</p>
          </div>
          
          <div className="space-y-4">
            <div>
              <button
                onClick={() => setMode('host-setup')}
                className="w-full bg-gradient-to-r from-green-500 to-emerald-600 text-white py-4 px-6 rounded-2xl font-semibold text-lg hover:from-green-600 hover:to-emerald-700 transition-all transform hover:scale-105 shadow-lg"
              >
                🎧 Host Session
              </button>
              <p className="text-gray-400 text-sm mt-2">Control music playback and broadcast to clients</p>
            </div>
            
            <div>
              <button
                onClick={() => setMode('client-setup')}
                className="w-full bg-gradient-to-r from-blue-500 to-cyan-600 text-white py-4 px-6 rounded-2xl font-semibold text-lg hover:from-blue-600 hover:to-cyan-700 transition-all transform hover:scale-105 shadow-lg"
              >
                📱 Join Session
              </button>
              <p className="text-gray-400 text-sm mt-2">Connect to a host and sync audio playback</p>
            </div>
          </div>
          
          <div className="mt-8 p-4 bg-yellow-500/20 rounded-xl border border-yellow-500/30">
            <h3 className="text-yellow-300 font-semibold mb-2">⚡ Web Demo Features:</h3>
            <ul className="text-yellow-100 text-sm space-y-1">
              <li>• WebRTC P2P connection (WiFi Direct alternative)</li>
              <li>• Sub-100ms audio synchronization</li>
              <li>• Real-time playback control</li>
              <li>• Automatic clock drift correction</li>
            </ul>
          </div>
        </div>
      </div>
    );
  }

  // Host Setup UI
  if (mode === 'host-setup') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-green-900 via-emerald-900 to-teal-900 flex items-center justify-center p-4">
        <div className="bg-white/10 backdrop-blur-lg rounded-3xl p-8 max-w-md w-full border border-white/20 shadow-2xl">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-white mb-2">🎧 Host Setup</h1>
            <p className="text-gray-300">Create a new music session</p>
          </div>
          
          <div className="space-y-6">
            <div>
              <label className="text-white font-medium mb-2 block">Session Name</label>
              <input
                type="text"
                value={sessionName}
                onChange={(e) => setSessionName(e.target.value)}
                placeholder="Enter session name..."
                className="w-full bg-white/20 border border-white/30 rounded-xl px-4 py-3 text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            </div>
            
            <div>
              <label className="text-white font-medium mb-2 block">Upload Audio File</label>
              <input
                type="file"
                accept="audio/*"
                onChange={handleFileUpload}
                className="w-full bg-white/20 border border-white/30 rounded-xl px-4 py-3 text-white file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:bg-green-500 file:text-white file:font-medium"
              />
              {audioFile && (
                <p className="text-green-300 text-sm mt-2">✓ {audioFile.name}</p>
              )}
            </div>
            
            <div className="flex space-x-3">
              <button
                onClick={() => setMode('selector')}
                className="flex-1 bg-gray-600 text-white py-3 px-6 rounded-xl font-medium hover:bg-gray-700 transition-colors"
              >
                Back
              </button>
              <button
                onClick={createSession}
                disabled={!sessionName.trim() || !audioFile}
                className="flex-1 bg-gradient-to-r from-green-500 to-emerald-600 text-white py-3 px-6 rounded-xl font-medium hover:from-green-600 hover:to-emerald-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Create
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Client Setup UI
  if (mode === 'client-setup') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-900 via-cyan-900 to-teal-900 flex items-center justify-center p-4">
        <div className="bg-white/10 backdrop-blur-lg rounded-3xl p-8 max-w-md w-full border border-white/20 shadow-2xl">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold text-white mb-2">📱 Join Session</h1>
            <p className="text-gray-300">Connect to an active host</p>
          </div>
          
          <div className="space-y-6">
            <div>
              <label className="text-white font-medium mb-2 block">Session ID</label>
              <input
                type="text"
                value={sessionId}
                onChange={(e) => setSessionId(e.target.value)}
                placeholder="Enter session ID..."
                className="w-full bg-white/20 border border-white/30 rounded-xl px-4 py-3 text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            
            <div className="flex space-x-3">
              <button
                onClick={() => setMode('selector')}
                className="flex-1 bg-gray-600 text-white py-3 px-6 rounded-xl font-medium hover:bg-gray-700 transition-colors"
              >
                Back
              </button>
              <button
                onClick={() => joinSession(sessionId)}
                disabled={!sessionId.trim()}
                className="flex-1 bg-gradient-to-r from-blue-500 to-cyan-600 text-white py-3 px-6 rounded-xl font-medium hover:from-blue-600 hover:to-cyan-700 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Join
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Host Control UI
  if (mode === 'host') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-green-900 via-emerald-900 to-teal-900 p-4">
        <div className="max-w-4xl mx-auto">
          {/* Header */}
          <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-6 mb-6 border border-white/20">
            <div className="flex justify-between items-center">
              <div>
                <h1 className="text-3xl font-bold text-white mb-1">🎧 Host Control</h1>
                <p className="text-gray-300">Session: {sessionName}</p>
                <p className="text-green-300 text-sm">ID: {sessionId}</p>
              </div>
              <div className="text-right">
                <div className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${
                  connectionState === 'connected' ? 'bg-green-500/20 text-green-300' : 'bg-red-500/20 text-red-300'
                }`}>
                  <div className={`w-2 h-2 rounded-full mr-2 ${
                    connectionState === 'connected' ? 'bg-green-400' : 'bg-red-400'
                  }`}></div>
                  {connectionState}
                </div>
                <p className="text-gray-400 text-sm mt-1">{connectedClients.length} clients</p>
              </div>
            </div>
          </div>

          {/* Audio Controls */}
          <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-6 mb-6 border border-white/20">
            <div className="text-center mb-6">
              {audioFile && (
                <div className="mb-4">
                  <h3 className="text-xl font-semibold text-white mb-2">🎵 {audioFile.name}</h3>
                  <div className="text-gray-300">
                    {formatTime(currentTime)} / {formatTime(duration)}
                  </div>
                </div>
              )}

              <div className="flex justify-center items-center space-x-4 mb-6">
                <button
                  onClick={() => audioEngine.current.seek(Math.max(0, currentTime - 10))}
                  className="p-3 bg-white/20 rounded-full hover:bg-white/30 transition-colors"
                  disabled={!audioFile}
                >
                  <span className="text-white text-xl">⏪</span>
                </button>
                
                <button
                  onClick={togglePlayback}
                  className="p-4 bg-gradient-to-r from-green-500 to-emerald-600 rounded-full hover:from-green-600 hover:to-emerald-700 transition-all transform hover:scale-105 disabled:opacity-50"
                  disabled={!audioFile}
                >
                  <span className="text-white text-2xl">
                    {isPlaying ? '⏸️' : '▶️'}
                  </span>
                </button>
                
                <button
                  onClick={() => audioEngine.current.seek(Math.min(duration, currentTime + 10))}
                  className="p-3 bg-white/20 rounded-full hover:bg-white/30 transition-colors"
                  disabled={!audioFile}
                >
                  <span className="text-white text-xl">⏩</span>
                </button>
              </div>

              {/* Volume Control */}
              <div className="flex items-center justify-center space-x-4">
                <span className="text-white text-xl">🔊</span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={volume}
                  onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
                  className="w-32 accent-green-500"
                />
                <span className="text-white text-sm w-12">{Math.round(volume * 100)}%</span>
              </div>
            </div>
          </div>

          {/* Connected Clients */}
          <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-6 border border-white/20">
            <h3 className="text-xl font-semibold text-white mb-4">📱 Connected Clients</h3>
            {connectedClients.length === 0 ? (
              <p className="text-gray-400 text-center py-4">No clients connected</p>
            ) : (
              <div className="space-y-2">
                {connectedClients.map((client) => (
                  <div key={client.id} className="flex items-center justify-between bg-white/5 rounded-lg p-3">
                    <span className="text-white">{client.name}</span>
                    <div className="w-2 h-2 bg-green-400 rounded-full"></div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Client UI
  if (mode === 'client') {
    return (
      <div className="min-h-screen bg-gradient-to-br from-blue-900 via-cyan-900 to-teal-900 p-4">
        <div className="max-w-2xl mx-auto">
          {/* Header */}
          <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-6 mb-6 border border-white/20">
            <div className="text-center">
              <h1 className="text-3xl font-bold text-white mb-2">📱 Client Mode</h1>
              <p className="text-gray-300">Session: {sessionId}</p>
              <div className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium mt-2 ${
                connectionState === 'connected' ? 'bg-green-500/20 text-green-300' : 'bg-red-500/20 text-red-300'
              }`}>
                <div className={`w-2 h-2 rounded-full mr-2 ${
                  connectionState === 'connected' ? 'bg-green-400' : 'bg-red-400'
                }`}></div>
                {connectionState}
              </div>
            </div>
          </div>

          {/* Sync Status */}
          <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-6 mb-6 border border-white/20">
            <div className="text-center">
              <h3 className="text-xl font-semibold text-white mb-4">🎵 Synchronized Playback</h3>
              
              <div className="mb-6">
                <div className="text-3xl text-white mb-2">
                  {isPlaying ? '▶️' : '⏸️'}
                </div>
                <div className="text-gray-300">
                  {formatTime(currentTime)}
                </div>
              </div>

              {/* Volume Control (Client Only) */}
              <div className="flex items-center justify-center space-x-4">
                <span className="text-white text-xl">🔊</span>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={volume}
                  onChange={(e) => handleVolumeChange(parseFloat(e.target.value))}
                  className="w-32 accent-blue-500"
                />
                <span className="text-white text-sm w-12">{Math.round(volume * 100)}%</span>
              </div>
            </div>
          </div>

          {/* Connection Info */}
          <div className="bg-white/10 backdrop-blur-lg rounded-2xl p-6 border border-white/20">
            <h3 className="text-xl font-semibold text-white mb-4">📡 Connection Status</h3>
            <div className="space-y-2 text-gray-300">
              <div className="flex justify-between">
                <span>Mode:</span>
                <span className="text-blue-300">Client</span>
              </div>
              <div className="flex justify-between">
                <span>Connection:</span>
                <span className={connectionState === 'connected' ? 'text-green-300' : 'text-red-300'}>
                  {connectionState}
                </span>
              </div>
              <div className="flex justify-between">
                <span>Sync Status:</span>
                <span className="text-green-300">
                  {connectionState === 'connected' ? 'Synchronized' : 'Waiting...'}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return null;
}

export default App;