import React, { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

const SIGNAL_SERVER_URL = "https://calls.softsales.com.br/";

// Use STUN público p/ dev; em produção adicione TURN próprio:
const RTC_CONFIG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    // { urls: "turn:SEU_TURN:3478", username: "user", credential: "pass" }
  ],
};

export default function App() {
  const [roomId, setRoomId] = useState("sala-demo");
  const [connected, setConnected] = useState(false);
  const [remoteSocketId, setRemoteSocketId] = useState(null);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [screenShareActive, setScreenShareActive] = useState(false);
  const socketRef = useRef(null);
  const pcRef = useRef(null);
  const localStreamRef = useRef(null);
  const screenStreamRef = useRef(null);

  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const screenShareRef = useRef(null);

  const [muted, setMuted] = useState(false);
  const [camOff, setCamOff] = useState(false);

  useEffect(() => {
    socketRef.current = io(SIGNAL_SERVER_URL, { transports: ["websocket"] });
    return () => socketRef.current?.disconnect();
  }, []);

  async function startLocalMedia() {
    try {
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

  function createPeerConnection() {
    const pc = new RTCPeerConnection(RTC_CONFIG);

    // Envie suas tracks
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        pc.addTrack(track, localStreamRef.current);
      });
    }

    // Receba tracks remotas
    pc.ontrack = (event) => {
      const [remoteStream] = event.streams;
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStream;
      }
    };

    // Envie candidatos ICE via sinalização
    pc.onicecandidate = (e) => {
      if (e.candidate && remoteSocketId) {
        socketRef.current.emit("signal", {
          to: remoteSocketId,
          data: { type: "ice-candidate", candidate: e.candidate },
        });
      }
    };

    // Monitorar mudanças de estado
    pc.onconnectionstatechange = () => {
      console.log("PC state:", pc.connectionState);
    };

    pcRef.current = pc;
    return pc;
  }

  async function joinRoom() {
    await startLocalMedia();

    // eventos de sinalização
    socketRef.current.on("joined", async ({ peers }) => {
      setConnected(true);
      // Se já tem alguém, esse cliente inicia a oferta
      if (peers.length > 0) {
        const other = peers[0];
        setRemoteSocketId(other);
        const pc = createPeerConnection();

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socketRef.current.emit("signal", { to: other, data: offer });
      }
    });

    socketRef.current.on("peer-joined", ({ socketId }) => {
      // Guardar pra enviar ICE/SDP
      setRemoteSocketId(socketId);
    });

    socketRef.current.on("signal", async ({ from, data }) => {
      // Salve quem é o par
      if (!remoteSocketId) setRemoteSocketId(from);

      const pc = pcRef.current ?? createPeerConnection();

      if (data.type === "offer") {
        await pc.setRemoteDescription(new RTCSessionDescription(data));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socketRef.current.emit("signal", { to: from, data: answer });
      } else if (data.type === "answer") {
        await pc.setRemoteDescription(new RTCSessionDescription(data));
      } else if (data.type === "ice-candidate") {
        try {
          await pc.addIceCandidate(data.candidate);
        } catch (err) {
          console.error("Erro ao adicionar ICE:", err);
        }
      }
    });

    socketRef.current.on("peer-left", () => {
      cleanupPeer();
    });

    socketRef.current.emit("join", { roomId });
  }

  function cleanupPeer() {
    if (pcRef.current) {
      pcRef.current.getSenders().forEach((s) => s.track && s.track.stop());
      pcRef.current.close();
      pcRef.current = null;
    }
    if (remoteVideoRef.current && remoteVideoRef.current.srcObject) {
      const tracks = remoteVideoRef.current.srcObject.getTracks();
      tracks.forEach((t) => t.stop());
      remoteVideoRef.current.srcObject = null;
    }
    setRemoteSocketId(null);
  }

  function leaveRoom() {
    socketRef.current.emit("leave");
    cleanupPeer();
    if (screenStreamRef.current) {
      screenStreamRef.current.getTracks().forEach(track => track.stop());
      screenStreamRef.current = null;
    }
    setConnected(false);
    setIsScreenSharing(false);
    setScreenShareActive(false);
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
        const sender = pcRef.current.getSenders().find((s) => s.track?.kind === "video");
        await sender.replaceTrack(videoTrack);

        // Restaurar o vídeo local para mostrar a câmera
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

      // Exibir a tela compartilhada no elemento de vídeo local
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = screenStream;
      }

      const videoTrack = screenStream.getVideoTracks()[0];
      const sender = pcRef.current.getSenders().find((s) => s.track?.kind === "video");

      await sender.replaceTrack(videoTrack);

      setIsScreenSharing(true);

      // Quando parar o compartilhamento, volta pra câmera
      videoTrack.onended = async () => {
        const camTrack = localStreamRef.current.getVideoTracks()[0];
        await sender.replaceTrack(camTrack);
        setIsScreenSharing(false);

        // Restaurar o vídeo local para mostrar a câmera
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

  return (
    <div style={{ maxWidth: 1200, margin: "2rem auto", fontFamily: "sans-serif" }}>
      <h1>WebRTC Chat com Compartilhamento de Tela</h1>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 16 }}>
        <input
          value={roomId}
          onChange={(e) => setRoomId(e.target.value)}
          placeholder="roomId"
          style={{ padding: "8px", borderRadius: "4px", border: "1px solid #ccc" }}
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
          style={{ padding: "8px 16px", backgroundColor: isScreenSharing ? "#9C27B0" : "#673AB7", color: "white", border: "none", borderRadius: "4px" }}
        >
          {isScreenSharing ? "Parar Compartilhamento" : "Compartilhar Tela"}
        </button>
      </div>

      <div style={{
        display: "grid",
        gridTemplateColumns: screenShareActive ? "1fr 1fr" : "1fr 1fr",
        gap: 16,
        marginTop: 16
      }}>
        <div>
          <h3>Sua Câmera</h3>
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

      {screenShareActive && (
        <div style={{ marginTop: 24 }}>
          <h3>Tela Compartilhada</h3>
          <video
            ref={screenShareRef}
            playsInline
            autoPlay
            style={{
              width: "100%",
              maxHeight: "400px",
              background: "#000",
              borderRadius: "8px",
              border: "2px solid #9C27B0"
            }}
          />
          <div style={{ marginTop: 8, color: "#9C27B0", fontWeight: "bold" }}>
            🖥️ Compartilhamento de tela ativo
          </div>
        </div>
      )}

      <div style={{
        marginTop: 24,
        padding: 16,
        borderRadius: "8px",
        border: "1px solid #ddd"
      }}>
        <h4>Status:</h4>
        <p>✅ {connected ? "Conectado" : "Desconectado"}</p>
        <p>👤 {remoteSocketId ? "Par conectado" : "Aguardando participante"}</p>
        <p>🎥 {camOff ? "Câmera desligada" : "Câmera ativa"}</p>
        <p>🔊 {muted ? "Microfone mudo" : "Microfone ativo"}</p>
        <p>🖥️ {isScreenSharing ? "Compartilhando tela" : "Tela não compartilhada"}</p>
      </div>
    </div>
  );
}