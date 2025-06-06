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
    
    // Live audio streaming
    this.mediaStream = null;
    this.mediaRecorder = null;
    this.isLiveBroadcasting = false;
    this.audioChunks = [];
    this.onAudioChunk = null; // Callback for audio chunks
    this.scriptProcessor = null;
    this.sourceAudioNode = null;
    
    // Client-side audio playback for live streams
    this.audioQueue = [];
    this.isPlaying = false;
    this.nextPlayTime = 0;
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

  // Microphone access for host
  async requestMicrophoneAccess() {
    try {
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 44100
        } 
      });
      return true;
    } catch (error) {
      console.error('Failed to access microphone:', error);
      return false;
    }
  }

  // Start live audio broadcasting (host)
  async startLiveBroadcast(onAudioChunk) {
    if (!this.mediaStream || !this.audioContext) return false;

    try {
      this.onAudioChunk = onAudioChunk;
      this.isLiveBroadcasting = true;
      
      // Create audio source from microphone
      this.sourceAudioNode = this.audioContext.createMediaStreamSource(this.mediaStream);
      
      // Create script processor for real-time audio processing
      this.scriptProcessor = this.audioContext.createScriptProcessor(4096, 1, 1);
      
      this.scriptProcessor.onaudioprocess = (event) => {
        if (!this.isLiveBroadcasting) return;
        
        const inputBuffer = event.inputBuffer;
        const inputData = inputBuffer.getChannelData(0);
        
        // Convert to ArrayBuffer for transmission
        const audioData = new Float32Array(inputData);
        const timestamp = performance.now();
        
        if (this.onAudioChunk) {
          this.onAudioChunk({
            audioData: Array.from(audioData),
            timestamp: timestamp,
            sampleRate: this.audioContext.sampleRate
          });
        }
      };
      
      // Connect the audio processing chain
      this.sourceAudioNode.connect(this.scriptProcessor);
      this.scriptProcessor.connect(this.gainNode);
      
      console.log('Live broadcast started');
      return true;
    } catch (error) {
      console.error('Failed to start live broadcast:', error);
      return false;
    }
  }

  // Stop live audio broadcasting (host)
  stopLiveBroadcast() {
    this.isLiveBroadcasting = false;
    
    if (this.scriptProcessor) {
      this.scriptProcessor.disconnect();
      this.scriptProcessor = null;
    }
    
    if (this.sourceAudioNode) {
      this.sourceAudioNode.disconnect();
      this.sourceAudioNode = null;
    }
    
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }
    
    console.log('Live broadcast stopped');
  }

  // Play received audio chunk (client)
  async playAudioChunk(audioData, timestamp, sampleRate) {
    if (!this.audioContext) return;

    try {
      // Create audio buffer from received data
      const audioBuffer = this.audioContext.createBuffer(1, audioData.length, sampleRate || 44100);
      const channelData = audioBuffer.getChannelData(0);
      
      for (let i = 0; i < audioData.length; i++) {
        channelData[i] = audioData[i];
      }
      
      // Create source node and play immediately with minimal delay
      const sourceNode = this.audioContext.createBufferSource();
      sourceNode.buffer = audioBuffer;
      sourceNode.connect(this.gainNode);
      
      // Calculate when to play (try to maintain real-time with small buffer)
      const currentTime = this.audioContext.currentTime;
      const playTime = Math.max(currentTime, this.nextPlayTime);
      
      sourceNode.start(playTime);
      this.nextPlayTime = playTime + audioBuffer.duration;
      
      // Clean up after playback
      sourceNode.onended = () => {
        sourceNode.disconnect();
      };
      
    } catch (error) {
      console.error('Failed to play audio chunk:', error);
    }
  }

  // Legacy file-based methods (keep for compatibility)
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
  
  // Live audio broadcasting states
  const [isLiveBroadcasting, setIsLiveBroadcasting] = useState(false);
  const [hasMicrophoneAccess, setHasMicrophoneAccess] = useState(false);
  const [broadcastMode, setBroadcastMode] = useState('file'); // 'file' or 'live'

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
        if (mode === 'client') {
          // Play received audio chunk in real-time
          audioEngine.current.playAudioChunk(
            data.audioData,
            data.timestamp,
            data.sampleRate
          );
        }
        break;
    }
  };

  const sendWebSocketMessage = (message) => {
    if (wsConnection.current && wsConnection.current.readyState === WebSocket.OPEN) {
      wsConnection.current.send(JSON.stringify(message));
    }
  };

  const requestMicrophoneAccess = async () => {
    const success = await audioEngine.current.requestMicrophoneAccess();
    setHasMicrophoneAccess(success);
    if (success) {
      setBroadcastMode('live');
    }
    return success;
  };

  const startLiveBroadcast = async () => {
    if (!hasMicrophoneAccess) {
      const success = await requestMicrophoneAccess();
      if (!success) {
        alert('Microphone access is required for live broadcasting');
        return;
      }
    }

    const success = await audioEngine.current.startLiveBroadcast((audioChunk) => {
      // Send audio chunk to all connected clients
      if (p2pManager.current) {
        p2pManager.current.sendData({
          type: 'audio_chunk',
          audioData: audioChunk.audioData,
          timestamp: audioChunk.timestamp,
          sampleRate: audioChunk.sampleRate
        });
      }
    });

    if (success) {
      setIsLiveBroadcasting(true);
      setIsPlaying(true);
    }
  };

  const stopLiveBroadcast = () => {
    audioEngine.current.stopLiveBroadcast();
    setIsLiveBroadcasting(false);
    setIsPlaying(false);
  };

  const toggleLiveBroadcast = () => {
    if (isLiveBroadcasting) {
      stopLiveBroadcast();
    } else {
      startLiveBroadcast();
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
              <label className="text-white font-medium mb-4 block">Broadcasting Mode</label>
              <div className="grid grid-cols-2 gap-3 mb-4">
                <button
                  onClick={() => setBroadcastMode('live')}
                  className={`p-4 rounded-xl border-2 transition-all ${
                    broadcastMode === 'live' 
                      ? 'border-green-500 bg-green-500/20 text-green-300' 
                      : 'border-white/30 bg-white/10 text-gray-300'
                  }`}
                >
                  <div className="text-2xl mb-2">🎙️</div>
                  <div className="font-medium">Live Audio</div>
                  <div className="text-sm opacity-75">Broadcast your voice</div>
                </button>
                
                <button
                  onClick={() => setBroadcastMode('file')}
                  className={`p-4 rounded-xl border-2 transition-all ${
                    broadcastMode === 'file' 
                      ? 'border-green-500 bg-green-500/20 text-green-300' 
                      : 'border-white/30 bg-white/10 text-gray-300'
                  }`}
                >
                  <div className="text-2xl mb-2">🎵</div>
                  <div className="font-medium">Audio File</div>
                  <div className="text-sm opacity-75">Play uploaded music</div>
                </button>
              </div>
              
              {broadcastMode === 'live' && (
                <div className="bg-blue-500/20 border border-blue-500/30 rounded-xl p-4">
                  <div className="flex items-center space-x-2 text-blue-300 mb-2">
                    <span className="text-lg">🎙️</span>
                    <span className="font-medium">Live Broadcasting</span>
                  </div>
                  <p className="text-blue-200 text-sm">
                    Your voice will be broadcast in real-time to all connected clients. 
                    Microphone access will be requested when you start the session.
                  </p>
                </div>
              )}
              
              {broadcastMode === 'file' && (
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
                disabled={!sessionName.trim() || (broadcastMode === 'file' && !audioFile)}
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
              {broadcastMode === 'live' ? (
                <div className="mb-4">
                  <h3 className="text-xl font-semibold text-white mb-2">
                    🎙️ Live Broadcasting
                    {isLiveBroadcasting && (
                      <span className="ml-2 inline-flex items-center px-2 py-1 rounded-full text-xs bg-red-500/20 text-red-300">
                        <div className="w-2 h-2 bg-red-400 rounded-full mr-1 animate-pulse"></div>
                        LIVE
                      </span>
                    )}
                  </h3>
                  <div className="text-gray-300">
                    {isLiveBroadcasting ? 'Broadcasting your voice...' : 'Ready to broadcast'}
                  </div>
                </div>
              ) : (
                audioFile && (
                  <div className="mb-4">
                    <h3 className="text-xl font-semibold text-white mb-2">🎵 {audioFile.name}</h3>
                    <div className="text-gray-300">
                      {formatTime(currentTime)} / {formatTime(duration)}
                    </div>
                  </div>
                )
              )}

              <div className="flex justify-center items-center space-x-4 mb-6">
                {broadcastMode === 'live' ? (
                  <button
                    onClick={toggleLiveBroadcast}
                    className={`p-4 rounded-full transition-all transform hover:scale-105 ${
                      isLiveBroadcasting 
                        ? 'bg-red-500 hover:bg-red-600' 
                        : 'bg-gradient-to-r from-green-500 to-emerald-600 hover:from-green-600 hover:to-emerald-700'
                    }`}
                    disabled={connectionState !== 'connected'}
                  >
                    <span className="text-white text-2xl">
                      {isLiveBroadcasting ? '🛑' : '🎙️'}
                    </span>
                  </button>
                ) : (
                  <>
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
                  </>
                )}
              </div>

              {broadcastMode === 'live' && connectionState !== 'connected' && (
                <div className="mb-4 p-3 bg-yellow-500/20 border border-yellow-500/30 rounded-xl">
                  <p className="text-yellow-300 text-sm">
                    💡 Connect clients first to start live broadcasting
                  </p>
                </div>
              )}

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
              <h3 className="text-xl font-semibold text-white mb-4">
                {isPlaying ? '🎙️ Live Audio Stream' : '🎵 Synchronized Playback'}
              </h3>
              
              <div className="mb-6">
                <div className="text-3xl text-white mb-2">
                  {isPlaying ? (
                    <div className="flex items-center justify-center space-x-2">
                      <span>🔊</span>
                      <div className="flex space-x-1">
                        <div className="w-1 h-8 bg-green-400 rounded animate-pulse"></div>
                        <div className="w-1 h-6 bg-green-400 rounded animate-pulse" style={{animationDelay: '0.1s'}}></div>
                        <div className="w-1 h-10 bg-green-400 rounded animate-pulse" style={{animationDelay: '0.2s'}}></div>
                        <div className="w-1 h-4 bg-green-400 rounded animate-pulse" style={{animationDelay: '0.3s'}}></div>
                        <div className="w-1 h-7 bg-green-400 rounded animate-pulse" style={{animationDelay: '0.4s'}}></div>
                      </div>
                    </div>
                  ) : (
                    '⏸️'
                  )}
                </div>
                <div className="text-gray-300">
                  {isPlaying ? 'Receiving live audio...' : formatTime(currentTime)}
                </div>
                
                {isPlaying && (
                  <div className="mt-2 inline-flex items-center px-3 py-1 rounded-full text-xs bg-green-500/20 text-green-300">
                    <div className="w-2 h-2 bg-green-400 rounded-full mr-2 animate-pulse"></div>
                    LIVE
                  </div>
                )}
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