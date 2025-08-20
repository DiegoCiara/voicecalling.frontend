import React, { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { v4 as uuidv4 } from 'uuid';

const SIGNAL_SERVER_URL = "https://calls.softsales.com.br/";

const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
  ],
};

export default function App() {
  const [roomId, setRoomId] = useState("");
  const [connected, setConnected] = useState(false);
  const [peers, setPeers] = useState({});
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const socketRef = useRef(null);
  const pcsRef = useRef({}); // Múltiplas conexões peer
  const localStreamRef = useRef(null);
  const screenStreamRef = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideosRef = useRef({});

  const [muted, setMuted] = useState(false);
  const [camOff, setCamOff] = useState(false);

  useEffect(() => {
    socketRef.current = io(SIGNAL_SERVER_URL, { transports: ["websocket"] });

    // Criar sala automaticamente ao carregar
    createNewRoom();

    return () => {
      socketRef.current?.disconnect();
      cleanupAll();
    };
  }, []);

  function createNewRoom() {
    const newRoomId = uuidv4();
    setRoomId(newRoomId);
    socketRef.current.emit("create-room");
  }

  async function startLocalMedia() {
    try {
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach(track => track.stop());
      }

      localStreamRef.current = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { width: 1280, height: 720 },
      });

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = localStreamRef.current;
      }
    } catch (error) {
      console.error("Erro ao acessar mídia local:", error);
    }
  }

  function createPeerConnection(remoteSocketId) {
    const pc = new RTCPeerConnection(RTC_CONFIG);

    // Adicionar tracks locais
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        pc.addTrack(track, localStreamRef.current);
      });
    }

    // Receber tracks remotas
    pc.ontrack = (event) => {
      const [remoteStream] = event.streams;
      if (!remoteVideosRef.current[remoteSocketId]) {
        // Criar novo elemento de vídeo para este peer
        const videoElement = document.createElement('video');
        videoElement.playsInline = true;
        videoElement.autoplay = true;
        videoElement.style.cssText = `
          width: 100%;
          height: 240px;
          background: #000;
          border-radius: 8px;
          border: 2px solid #ddd;
          margin-bottom: 16px;
        `;

        const container = document.getElementById('remote-videos-container');
        if (container) {
          container.appendChild(videoElement);
          remoteVideosRef.current[remoteSocketId] = videoElement;
        }
      }

      if (remoteVideosRef.current[remoteSocketId]) {
        remoteVideosRef.current[remoteSocketId].srcObject = remoteStream;
      }
    };

    // Enviar candidatos ICE
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        socketRef.current.emit("signal", {
          to: remoteSocketId,
          data: { type: "ice-candidate", candidate: e.candidate },
        });
      }
    };

    pc.onconnectionstatechange = () => {
      console.log(`PC ${remoteSocketId} state:`, pc.connectionState);
      if (pc.connectionState === 'connected') {
        setPeers(prev => ({
          ...prev,
          [remoteSocketId]: { connected: true }
        }));
      }
    };

    pcsRef.current[remoteSocketId] = pc;
    return pc;
  }

  async function handleOffer(from, offer) {
    let pc = pcsRef.current[from];
    if (!pc) {
      pc = createPeerConnection(from);
    }

    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socketRef.current.emit("signal", {
      to: from,
      data: answer
    });
  }

  async function handleAnswer(from, answer) {
    const pc = pcsRef.current[from];
    if (pc) {
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
    }
  }

  async function handleIceCandidate(from, candidate) {
    const pc = pcsRef.current[from];
    if (pc) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        console.error("Erro ao adicionar ICE:", err);
      }
    }
  }

  async function joinRoom() {
    await startLocalMedia();

    socketRef.current.on("joined", async ({ peers: peerIds }) => {
      setConnected(true);
      console.log("Peers na sala:", peerIds);

      // Conectar com cada peer existente
      for (const peerId of peerIds) {
        if (!pcsRef.current[peerId]) {
          const pc = createPeerConnection(peerId);
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);

          socketRef.current.emit("signal", {
            to: peerId,
            data: offer
          });
        }
      }
    });

    socketRef.current.on("peer-joined", async ({ socketId }) => {
      console.log("Novo peer entrou:", socketId);

      // Iniciar conexão com o novo peer
      if (!pcsRef.current[socketId]) {
        const pc = createPeerConnection(socketId);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        socketRef.current.emit("signal", {
          to: socketId,
          data: offer
        });
      }
    });

    socketRef.current.on("signal", async ({ from, data }) => {
      switch (data.type) {
        case "offer":
          await handleOffer(from, data);
          break;
        case "answer":
          await handleAnswer(from, data);
          break;
        case "ice-candidate":
          await handleIceCandidate(from, data.candidate);
          break;
      }
    });

    socketRef.current.on("peer-left", ({ socketId }) => {
      cleanupPeer(socketId);
    });

    socketRef.current.on("room-created", ({ roomId: newRoomId }) => {
      setRoomId(newRoomId);
    });

    socketRef.current.emit("join", { roomId });
  }

  function cleanupPeer(socketId) {
    if (pcsRef.current[socketId]) {
      pcsRef.current[socketId].close();
      delete pcsRef.current[socketId];
    }

    if (remoteVideosRef.current[socketId]) {
      remoteVideosRef.current[socketId].remove();
      delete remoteVideosRef.current[socketId];
    }

    setPeers(prev => {
      const newPeers = { ...prev };
      delete newPeers[socketId];
      return newPeers;
    });
  }

  function cleanupAll() {
    Object.keys(pcsRef.current).forEach(cleanupPeer);

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }

    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(track => track.stop());
      screenStreamRef.current = null;
    }
  }

  function leaveRoom() {
    socketRef.current.emit("leave");
    cleanupAll();
    setConnected(false);
    setIsScreenSharing(false);
  }

  function toggleMute() {
    const tracks = localStreamRef.current?.getAudioTracks?.() || [];
    tracks.forEach((t) => (t.enabled = !t.enabled));
    setMuted((m) => !m);
  }

  function toggleCam() {
    const tracks = localStreamRef.current?.getVideoTracks?.() || [];
    tracks.forEach((t) => (t.enabled = !t.enabled));
    setCamOff((c) => !c);
  }

  async function shareScreen() {
    try {
      if (isScreenSharing) {
        // Parar compartilhamento
        if (screenStreamRef.current) {
          screenStreamRef.current.getTracks().forEach(track => track.stop());
          screenStreamRef.current = null;
        }

        // Voltar para a câmera
        const videoTrack = localStreamRef.current.getVideoTracks()[0];

        // Atualizar todos os peers
        Object.values(pcsRef.current).forEach(pc => {
          const sender = pc.getSenders().find((s) => s.track?.kind === "video");
          if (sender) sender.replaceTrack(videoTrack);
        });

        if (localVideoRef.current) {
          localVideoRef.current.srcObject = localStreamRef.current;
        }

        setIsScreenSharing(false);
        return;
      }

      // Iniciar compartilhamento
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true
      });

      screenStreamRef.current = screenStream;

      // Exibir a tela compartilhada
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = screenStream;
      }

      const videoTrack = screenStream.getVideoTracks()[0];

      // Atualizar todos os peers
      Object.values(pcsRef.current).forEach(pc => {
        const sender = pc.getSenders().find((s) => s.track?.kind === "video");
        if (sender) sender.replaceTrack(videoTrack);
      });

      setIsScreenSharing(true);

      // Quando parar o compartilhamento
      videoTrack.onended = async () => {
        const camTrack = localStreamRef.current.getVideoTracks()[0];

        Object.values(pcsRef.current).forEach(pc => {
          const sender = pc.getSenders().find((s) => s.track?.kind === "video");
          if (sender) sender.replaceTrack(camTrack);
        });

        setIsScreenSharing(false);
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = localStreamRef.current;
        }

        if (screenStreamRef.current) {
          screenStreamRef.current.getTracks().forEach(track => track.stop());
          screenStreamRef.current = null;
        }
      };

    } catch (error) {
      console.error("Erro ao compartilhar tela:", error);
    }
  }

  const participantCount = Object.keys(peers).length;

  return (
    <div style={{ maxWidth: 1200, margin: "2rem auto", fontFamily: "sans-serif" }}>
      <h1>WebRTC Video Chat com Multi-Salas</h1>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span>Sala ID:</span>
          <input
            value={roomId}
            onChange={(e) => setRoomId(e.target.value)}
            placeholder="ID da Sala"
            style={{ padding: "8px", borderRadius: "4px", border: "1px solid #ccc", minWidth: '200px' }}
          />
        </div>

        {!connected ? (
          <button
            onClick={joinRoom}
            style={{ padding: "8px 16px", backgroundColor: "#4CAF50", color: "white", border: "none", borderRadius: "4px" }}
          >
            Entrar na Sala
          </button>
        ) : (
          <button
            onClick={leaveRoom}
            style={{ padding: "8px 16px", backgroundColor: "#f44336", color: "white", border: "none", borderRadius: "4px" }}
          >
            Sair da Sala
          </button>
        )}

        <button
          onClick={createNewRoom}
          style={{ padding: "8px 16px", backgroundColor: "#607D8B", color: "white", border: "none", borderRadius: "4px" }}
        >
          Nova Sala
        </button>

        <button
          onClick={toggleMute}
          style={{ padding: "8px 16px", backgroundColor: muted ? "#666" : "#2196F3", color: "white", border: "none", borderRadius: "4px" }}
        >
          {muted ? "Desmutar" : "Mutar"}
        </button>

        <button
          onClick={toggleCam}
          style={{ padding: "8px 16px", backgroundColor: camOff ? "#666" : "#FF9800", color: "white", border: "none", borderRadius: "4px" }}
        >
          {camOff ? "Ligar Câmera" : "Desligar Câmera"}
        </button>

        <button
          onClick={shareScreen}
          style={{ padding: "8px 16px", backgroundColor: isScreenSharing ? "#9C27B0" : "#673AB7", color: "white", border: "none", borderRadius: "4px" }}
        >
          {isScreenSharing ? "Parar Tela" : "Compartilhar Tela"}
        </button>
      </div>

      <div style={{ marginBottom: '16px', padding: '12px', background: '#f5f5f5', borderRadius: '8px' }}>
        <strong>Compartilhe este ID para outros participarem: </strong>
        <code>{roomId}</code>
        <button
          onClick={() => navigator.clipboard.writeText(roomId)}
          style={{ marginLeft: '8px', padding: '4px 8px', fontSize: '12px' }}
        >
          Copiar
        </button>
      </div>

      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 16,
        marginBottom: 24
      }}>
        <div>
          <h3>Sua Câmera {isScreenSharing && '(Compartilhando Tela)'}</h3>
          <video
            ref={localVideoRef}
            playsInline
            autoPlay
            muted
            style={{
              width: "100%",
              height: "240px",
              background: "#000",
              borderRadius: "8px",
              border: "2px solid #ddd"
            }}
          />
        </div>

        <div>
          <h3>Participantes Remotos ({participantCount})</h3>
          <div id="remote-videos-container">
            {/* Vídeos remotos serão adicionados dinamicamente aqui */}
            {participantCount === 0 && (
              <div style={{
                width: "100%",
                height: "240px",
                background: "#f0f0f0",
                borderRadius: "8px",
                border: "2px dashed #ddd",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#666"
              }}>
                Aguardando participantes...
              </div>
            )}
          </div>
        </div>
      </div>

      <div style={{
        padding: 16,
        borderRadius: "8px",
        border: "1px solid #ddd",
        background: '#f9f9f9'
      }}>
        <h4>Status da Sala:</h4>
        <p>✅ {connected ? `Conectado na sala: ${roomId}` : "Desconectado"}</p>
        <p>👥 Participantes: {participantCount + 1} (você + {participantCount} remotos)</p>
        <p>🎥 {camOff ? "Câmera desligada" : "Câmera ativa"}</p>
        <p>🔊 {muted ? "Microfone mudo" : "Microfone ativo"}</p>
        <p>🖥️ {isScreenSharing ? "Compartilhando tela" : "Tela não compartilhada"}</p>
      </div>
    </div>
  );
}