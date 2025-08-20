import React, { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

const SIGNAL_SERVER_URL = "https://calls.softsales.com.br/";

const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun2.l.google.com:19302" },
    // Adicione servidores TURN aqui para produção
  ],
};

export default function App() {
  const [roomId, setRoomId] = useState("sala-demo");
  const [connected, setConnected] = useState(false);
  const [remoteSocketId, setRemoteSocketId] = useState(null);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [muted, setMuted] = useState(false);
  const [camOff, setCamOff] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState("disconnected");
  const [logs, setLogs] = useState([]);

  const socketRef = useRef(null);
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const screenStreamRef = useRef(null);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);

  const addLog = (message) => {
    console.log(message);
    setLogs(prev => [...prev, `${new Date().toLocaleTimeString()}: ${message}`]);
  };

  useEffect(() => {
    socketRef.current = io(SIGNAL_SERVER_URL, {
      transports: ["websocket", "polling"],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000,
    });

    return () => {
      socketRef.current?.disconnect();
      cleanupMedia();
    };
  }, []);

  const cleanupMedia = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => track.stop());
      localStreamRef.current = null;
    }
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(track => track.stop());
      screenStreamRef.current = null;
    }
  };

  async function startLocalMedia() {
    try {
      cleanupMedia();

      localStreamRef.current = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { width: 1280, height: 720 },
      });

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = localStreamRef.current;
      }
      addLog("Mídia local iniciada");
    } catch (error) {
      console.error("Erro ao acessar mídia local:", error);
      addLog(`Erro ao acessar mídia: ${error.message}`);
    }
  }

  function createPeerConnection() {
    try {
      const pc = new RTCPeerConnection(RTC_CONFIG);
      addLog("Nova conexão PeerConnection criada");

      // Adicionar tracks locais
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => {
          pc.addTrack(track, localStreamRef.current);
        });
        addLog("Tracks locais adicionadas à conexão");
      }

      // Receber tracks remotas
      pc.ontrack = (event) => {
        addLog("Track remota recebida");
        const [remoteStream] = event.streams;
        if (remoteVideoRef.current && remoteStream) {
          remoteVideoRef.current.srcObject = remoteStream;
          addLog("Stream remoto configurado no vídeo");
        }
      };

      // Enviar candidatos ICE
      pc.onicecandidate = (e) => {
        if (e.candidate && remoteSocketId) {
          socketRef.current.emit("signal", {
            to: remoteSocketId,
            data: { type: "ice-candidate", candidate: e.candidate },
          });
          addLog("Candidato ICE enviado");
        }
      };

      // Monitorar mudanças de estado
      pc.onconnectionstatechange = () => {
        const state = pc.connectionState;
        setConnectionStatus(state);
        addLog(`Estado da conexão: ${state}`);

        if (state === "connected") {
          addLog("✅ Conexão estabelecida com sucesso!");
        } else if (state === "failed" || state === "disconnected") {
          addLog("❌ Conexão falhou ou foi desconectada");
        }
      };

      pc.oniceconnectionstatechange = () => {
        addLog(`Estado ICE: ${pc.iceConnectionState}`);
      };

      pcRef.current = pc;
      return pc;
    } catch (error) {
      console.error("Erro ao criar PeerConnection:", error);
      addLog(`Erro ao criar conexão: ${error.message}`);
      return null;
    }
  }

  async function handleOffer(from, offer) {
    try {
      let pc = pcRef.current;
      if (!pc) {
        pc = createPeerConnection();
        if (!pc) return;
      }

      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      addLog("Offer remoto configurado");

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      addLog("Answer criado e configurado localmente");

      socketRef.current.emit("signal", {
        to: from,
        data: answer
      });
      addLog("Answer enviado para o par");

    } catch (error) {
      console.error("Erro ao processar offer:", error);
      addLog(`Erro ao processar offer: ${error.message}`);
    }
  }

  async function handleAnswer(answer) {
    try {
      if (!pcRef.current) {
        addLog("Nenhuma PeerConnection para configurar answer");
        return;
      }

      await pcRef.current.setRemoteDescription(new RTCSessionDescription(answer));
      addLog("Answer remoto configurado com sucesso");

    } catch (error) {
      console.error("Erro ao processar answer:", error);
      addLog(`Erro ao processar answer: ${error.message}`);
    }
  }

  async function handleIceCandidate(candidate) {
    try {
      if (!pcRef.current) {
        addLog("Nenhuma PeerConnection para adicionar ICE candidate");
        return;
      }

      await pcRef.current.addIceCandidate(candidate);
      addLog("Candidato ICE adicionado");

    } catch (error) {
      console.error("Erro ao adicionar ICE candidate:", error);
      addLog(`Erro ao adicionar ICE: ${error.message}`);
    }
  }

  async function joinRoom() {
    try {
      await startLocalMedia();

      // Configurar handlers de sinalização
      socketRef.current.on("joined", async ({ peers }) => {
        setConnected(true);
        addLog(`Conectado à sala. Peers: ${peers.length}`);

        if (peers.length > 0) {
          const other = peers[0];
          setRemoteSocketId(other);
          addLog(`Peer encontrado: ${other}`);

          const pc = createPeerConnection();
          if (!pc) return;

          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          addLog("Offer criado e configurado localmente");

          socketRef.current.emit("signal", {
            to: other,
            data: offer
          });
          addLog("Offer enviado para o par");
        }
      });

      socketRef.current.on("peer-joined", ({ socketId }) => {
        setRemoteSocketId(socketId);
        addLog(`Novo peer entrou: ${socketId}`);

        // Se já temos mídia e conexão, criar nova oferta
        if (localStreamRef.current && pcRef.current) {
          setTimeout(() => createOfferForNewPeer(socketId), 1000);
        }
      });

      socketRef.current.on("signal", async ({ from, data }) => {
        addLog(`Sinal recebido de ${from}: ${data.type}`);

        setRemoteSocketId(from);

        switch (data.type) {
          case "offer":
            await handleOffer(from, data);
            break;
          case "answer":
            await handleAnswer(data);
            break;
          case "ice-candidate":
            await handleIceCandidate(data.candidate);
            break;
          default:
            addLog(`Tipo de sinal desconhecido: ${data.type}`);
        }
      });

      socketRef.current.on("peer-left", () => {
        addLog("Peer saiu da sala");
        cleanupPeer();
      });

      socketRef.current.on("connect_error", (error) => {
        console.error("Erro de conexão socket:", error);
        addLog(`Erro de conexão: ${error.message}`);
      });

      socketRef.current.emit("join", { roomId });
      addLog(`Solicitando entrada na sala: ${roomId}`);

    } catch (error) {
      console.error("Erro ao entrar na sala:", error);
      addLog(`Erro ao entrar na sala: ${error.message}`);
    }
  }

  async function createOfferForNewPeer(peerId) {
    try {
      if (!pcRef.current) {
        const pc = createPeerConnection();
        if (!pc) return;
      }

      const offer = await pcRef.current.createOffer();
      await pcRef.current.setLocalDescription(offer);

      socketRef.current.emit("signal", {
        to: peerId,
        data: offer
      });
      addLog(`Nova offer enviada para ${peerId}`);

    } catch (error) {
      console.error("Erro ao criar offer para novo peer:", error);
      addLog(`Erro ao criar offer: ${error.message}`);
    }
  }

  function cleanupPeer() {
    if (pcRef.current) {
      pcRef.current.close();
      pcRef.current = null;
      addLog("PeerConnection limpa");
    }

    if (remoteVideoRef.current && remoteVideoRef.current.srcObject) {
      remoteVideoRef.current.srcObject = null;
    }

    setRemoteSocketId(null);
    setConnectionStatus("disconnected");
  }

  function leaveRoom() {
    if (socketRef.current) {
      socketRef.current.emit("leave");
      addLog("Saindo da sala");
    }

    cleanupPeer();
    cleanupMedia();

    setConnected(false);
    setIsScreenSharing(false);
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
        const sender = pcRef.current.getSenders().find((s) => s.track?.kind === "video");

        if (sender && videoTrack) {
          await sender.replaceTrack(videoTrack);
        }

        if (localVideoRef.current) {
          localVideoRef.current.srcObject = localStreamRef.current;
        }

        setIsScreenSharing(false);
        addLog("Compartilhamento de tela parado");
        return;
      }

      // Iniciar compartilhamento
      const screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true
      });

      screenStreamRef.current = screenStream;

      // Exibir a tela compartilhada localmente
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = screenStream;
      }

      const videoTrack = screenStream.getVideoTracks()[0];
      const sender = pcRef.current.getSenders().find((s) => s.track?.kind === "video");

      if (sender && videoTrack) {
        await sender.replaceTrack(videoTrack);
        addLog("Track de tela substituída na conexão");
      }

      setIsScreenSharing(true);
      addLog("Compartilhamento de tela iniciado");

      // Handler para quando o usuário para o compartilhamento
      videoTrack.onended = async () => {
        const camTrack = localStreamRef.current.getVideoTracks()[0];
        if (sender && camTrack) {
          await sender.replaceTrack(camTrack);
        }

        if (localVideoRef.current) {
          localVideoRef.current.srcObject = localStreamRef.current;
        }

        setIsScreenSharing(false);
        addLog("Compartilhamento de tela finalizado pelo usuário");
      };

    } catch (error) {
      console.error("Erro ao compartilhar tela:", error);
      addLog(`Erro ao compartilhar tela: ${error.message}`);
    }
  }

  // Funções toggleMute e toggleCam permanecem as mesmas
  function toggleMute() {
    const tracks = localStreamRef.current?.getAudioTracks?.() || [];
    tracks.forEach((t) => (t.enabled = !t.enabled));
    setMuted((m) => !m);
    addLog(muted ? "Microfone ativado" : "Microfone mutado");
  }

  function toggleCam() {
    const tracks = localStreamRef.current?.getVideoTracks?.() || [];
    tracks.forEach((t) => (t.enabled = !t.enabled));
    setCamOff((c) => !c);
    addLog(camOff ? "Câmera ativada" : "Câmera desativada");
  }

  return (
    <div style={{ maxWidth: 1200, margin: "2rem auto", fontFamily: "sans-serif", padding: "0 1rem" }}>
      <h1>WebRTC Chat com Compartilhamento de Tela</h1>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
        <input
          value={roomId}
          onChange={(e) => setRoomId(e.target.value)}
          placeholder="roomId"
          style={{ padding: "8px", borderRadius: "4px", border: "1px solid #ccc", minWidth: "120px" }}
        />
        {!connected ? (
          <button
            onClick={joinRoom}
            style={{ padding: "8px 16px", backgroundColor: "#4CAF50", color: "white", border: "none", borderRadius: "4px" }}
          >
            Entrar
          </button>
        ) : (
          <button
            onClick={leaveRoom}
            style={{ padding: "8px 16px", backgroundColor: "#f44336", color: "white", border: "none", borderRadius: "4px" }}
          >
            Sair
          </button>
        )}
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
          disabled={!connected}
          style={{
            padding: "8px 16px",
            backgroundColor: isScreenSharing ? "#9C27B0" : "#673AB7",
            color: "white",
            border: "none",
            borderRadius: "4px",
            opacity: connected ? 1 : 0.5
          }}
        >
          {isScreenSharing ? "Parar Tela" : "Compartilhar Tela"}
        </button>
      </div>

      <div style={{
        display: "grid",
        gridTemplateColumns: "1fr 1fr",
        gap: 16,
        marginTop: 16
      }}>
        <div>
          <h3>Sua Câmera {isScreenSharing && "(Tela Compartilhada)"}</h3>
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
          <h3>Participante Remoto</h3>
          <video
            ref={remoteVideoRef}
            playsInline
            autoPlay
            style={{
              width: "100%",
              height: "240px",
              background: "#000",
              borderRadius: "8px",
              border: "2px solid #ddd"
            }}
          />
        </div>
      </div>

      <div style={{
        marginTop: 24,
        padding: 16,
        borderRadius: "8px",
        border: "1px solid #ddd",
        backgroundColor: "#f9f9f9"
      }}>
        <h4>Status:</h4>
        <p>✅ {connected ? "Conectado" : "Desconectado"}</p>
        <p>🔗 Estado: {connectionStatus}</p>
        <p>👤 {remoteSocketId ? `Par conectado: ${remoteSocketId}` : "Aguardando participante"}</p>
        <p>🎥 {camOff ? "Câmera desligada" : "Câmera ativa"}</p>
        <p>🔊 {muted ? "Microfone mudo" : "Microfone ativo"}</p>
        <p>🖥️ {isScreenSharing ? "Compartilhando tela" : "Tela não compartilhada"}</p>
      </div>

      <div style={{ marginTop: 24 }}>
        <h4>Logs de Depuração:</h4>
        <div style={{
          height: "200px",
          overflowY: "auto",
          backgroundColor: "#333",
          color: "#fff",
          padding: "12px",
          borderRadius: "4px",
          fontSize: "12px",
          fontFamily: "monospace"
        }}>
          {logs.slice(-20).map((log, index) => (
            <div key={index} style={{ marginBottom: "4px" }}>{log}</div>
          ))}
        </div>
      </div>
    </div>
  );
}