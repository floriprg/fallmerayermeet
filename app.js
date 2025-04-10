// Konfiguration
const config = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' }
    ],
    socketServer: window.location.hostname === 'localhost'
        ? 'http://localhost:3000'
        : 'https://your-webrtc-server.com'
};

// Globale Variablen
let socket;
let localStream;
let peerConnections = {};
let roomName;
let username;
let localVideoElement;
let isMuted = false;
let isVideoOff = false;
let isScreenSharing = false;
let screenStream;
let dataChannels = {};

// DOM-Elemente
const loginOverlay = document.getElementById('login-overlay');
const container = document.querySelector('.container');
const usernameInput = document.getElementById('usernameInput');
const roomInput = document.getElementById('roomInput');
const joinButton = document.getElementById('joinButton');
const roomNameDisplay = document.getElementById('roomNameDisplay');
const participantCount = document.getElementById('participantCount');
const videoContainer = document.getElementById('videoContainer');
const participantsList = document.getElementById('participants');
const chatMessages = document.getElementById('chatMessages');
const messageInput = document.getElementById('messageInput');
const sendButton = document.getElementById('sendButton');
const screenShareButton = document.getElementById('screenShareButton');
const muteButton = document.getElementById('muteButton');
const videoOffButton = document.getElementById('videoOffButton');
const hangupButton = document.getElementById('hangupButton');

// Event Listener
joinButton.addEventListener('click', joinRoom);
sendButton.addEventListener('click', sendMessage);
messageInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') sendMessage();
});
screenShareButton.addEventListener('click', toggleScreenShare);
muteButton.addEventListener('click', toggleMute);
videoOffButton.addEventListener('click', toggleVideo);
hangupButton.addEventListener('click', leaveRoom);

// Hauptfunktionen
async function joinRoom() {
    username = usernameInput.value.trim();
    roomName = roomInput.value.trim();

    if (!username || !roomName) {
        alert('Bitte geben Sie einen Namen und einen Raum ein');
        return;
    }

    try {
        // Medienzugriff starten
        localStream = await navigator.mediaDevices.getUserMedia({
            video: true,
            audio: true
        });

        // Socket-Verbindung herstellen
        socket = io(config.socketServer);

        // Socket-Events
        socket.on('connect', () => {
            console.log('Mit Socket-Server verbunden');
            socket.emit('join', { username, room: roomName });
        });

        socket.on('user-list', updateParticipantsList);
        socket.on('user-joined', handleNewPeer);
        socket.on('offer', handleOffer);
        socket.on('answer', handleAnswer);
        socket.on('ice-candidate', handleIceCandidate);
        socket.on('user-left', handlePeerLeave);
        socket.on('chat-message', handleChatMessage);
        socket.on('room-info', updateRoomInfo);

        // Lokales Video anzeigen
        localVideoElement = createVideoElement(localStream, username, true);
        videoContainer.appendChild(localVideoElement);

        // UI aktualisieren
        loginOverlay.style.display = 'none';
        container.style.display = 'flex';

        addSystemMessage(`Willkommen im Raum "${roomName}"`);
    } catch (err) {
        console.error('Fehler beim Beitreten des Raums:', err);
        alert('Fehler beim Beitreten des Raums: ' + err.message);
    }
}

function leaveRoom() {
    // Streams stoppen
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }

    if (screenStream) {
        screenStream.getTracks().forEach(track => track.stop());
    }

    // Peer-Verbindungen schließen
    Object.keys(peerConnections).forEach(id => {
        peerConnections[id].close();
    });
    peerConnections = {};

    // Socket-Verbindung schließen
    if (socket) {
        socket.emit('leave', roomName);
        socket.disconnect();
    }

    // UI zurücksetzen
    videoContainer.innerHTML = '';
    participantsList.innerHTML = '';
    chatMessages.innerHTML = '';

    container.style.display = 'none';
    loginOverlay.style.display = 'flex';
}

// WebRTC Funktionen
async function handleNewPeer(userId) {
    if (userId === socket.id) return;

    const peerConnection = new RTCPeerConnection(config);
    peerConnections[userId] = peerConnection;

    // DataChannel erstellen
    const dataChannel = peerConnection.createDataChannel('chat');
    setupDataChannel(dataChannel, userId);
    dataChannels[userId] = dataChannel;

    // Lokale Streams hinzufügen
    localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
    });

    // ICE Candidate handler
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', {
                candidate: event.candidate,
                to: userId,
                room: roomName
            });
        }
    };

    // Remote Stream handler
    peerConnection.ontrack = (event) => {
        const remoteStream = event.streams[0];
        const userId = event.streams[0].id;
        const participant = getParticipantInfo(userId);

        if (participant) {
            createVideoElement(remoteStream, participant.username, false, userId);
        }
    };

    // Offer erstellen
    try {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);

        socket.emit('offer', {
            offer,
            to: userId,
            room: roomName
        });
    } catch (err) {
        console.error('Fehler beim Erstellen des Offers:', err);
    }
}

async function handleOffer({ offer, from }) {
    const peerConnection = new RTCPeerConnection(config);
    peerConnections[from] = peerConnection;

    // DataChannel handler
    peerConnection.ondatachannel = (event) => {
        const dataChannel = event.channel;
        setupDataChannel(dataChannel, from);
        dataChannels[from] = dataChannel;
    };

    // Lokale Streams hinzufügen
    localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
    });

    // ICE Candidate handler
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', {
                candidate: event.candidate,
                to: from,
                room: roomName
            });
        }
    };

    // Remote Stream handler
    peerConnection.ontrack = (event) => {
        const remoteStream = event.streams[0];
        const userId = event.streams[0].id;
        const participant = getParticipantInfo(userId);

        if (participant) {
            createVideoElement(remoteStream, participant.username, false, userId);
        }
    };

    try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        socket.emit('answer', {
            answer,
            to: from,
            room: roomName
        });
    } catch (err) {
        console.error('Fehler beim Behandeln des Offers:', err);
    }
}

async function handleAnswer({ answer, from }) {
    const peerConnection = peerConnections[from];
    if (peerConnection) {
        try {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
        } catch (err) {
            console.error('Fehler beim Behandeln des Answers:', err);
        }
    }
}

function handleIceCandidate({ candidate, from }) {
    const peerConnection = peerConnections[from];
    if (peerConnection && candidate) {
        peerConnection.addIceCandidate(new RTCIceCandidate(candidate))
            .catch(err => console.error('Fehler beim Hinzufügen des ICE Candidates:', err));
    }
}

function handlePeerLeave(userId) {
    const peerConnection = peerConnections[userId];
    if (peerConnection) {
        peerConnection.close();
        delete peerConnections[userId];
    }

    // Video-Element entfernen
    const videoElement = document.getElementById(`video-${userId}`);
    if (videoElement) {
        videoElement.remove();
    }

    // DataChannel entfernen
    delete dataChannels[userId];

    addSystemMessage(`${getParticipantInfo(userId)?.username || 'Ein Benutzer'} hat den Raum verlassen`);
}

// UI Funktionen
function createVideoElement(stream, name, isLocal = false, userId = null) {
    const videoId = isLocal ? 'local' : `remote-${userId}`;
    const videoItem = document.createElement('div');
    videoItem.className = 'video-item';
    videoItem.id = `video-${userId || 'local'}`;

    const video = document.createElement('video');
    video.id = videoId;
    video.autoplay = true;
    video.playsInline = true;
    video.srcObject = stream;
    if (isLocal) video.muted = true;

    const videoInfo = document.createElement('div');
    videoInfo.className = 'video-info';

    const micIcon = document.createElement('i');
    micIcon.className = isLocal
        ? (isMuted ? 'fas fa-microphone-slash' : 'fas fa-microphone')
        : 'fas fa-microphone';

    const nameSpan = document.createElement('span');
    nameSpan.textContent = name;

    videoInfo.appendChild(micIcon);
    videoInfo.appendChild(nameSpan);

    if (isLocal) {
        const videoControls = document.createElement('div');
        videoControls.className = 'video-controls';

        const flipButton = document.createElement('button');
        flipButton.innerHTML = '<i class="fas fa-camera-rotate"></i>';
        flipButton.title = 'Kamera wechseln';
        flipButton.addEventListener('click', flipCamera);

        videoControls.appendChild(flipButton);
        videoItem.appendChild(videoControls);
    }

    videoItem.appendChild(video);
    videoItem.appendChild(videoInfo);

    return videoItem;
}

function updateParticipantsList(users) {
    participantsList.innerHTML = '';
    users.forEach(user => {
        const li = document.createElement('li');
        li.textContent = user.username;
        if (user.id === socket.id) {
            li.innerHTML += ' <em>(Sie)</em>';
        }
        participantsList.appendChild(li);
    });
}

function updateRoomInfo(info) {
    roomNameDisplay.querySelector('span').textContent = info.room;
    participantCount.textContent = `${info.participants} Teilnehmer`;
}

function addSystemMessage(message) {
    const messageElement = document.createElement('div');
    messageElement.className = 'message system';
    messageElement.textContent = message;
    chatMessages.appendChild(messageElement);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addChatMessage(message, isLocal = false) {
    const messageElement = document.createElement('div');
    messageElement.className = `message ${isLocal ? 'local' : 'remote'}`;
    messageElement.textContent = message;
    chatMessages.appendChild(messageElement);
    chatMessages.scrollTop = chatMessages.scrollHeight;
}

// Chat Funktionen
function sendMessage() {
    const message = messageInput.value.trim();
    if (message) {
        // Nachricht an alle Peers senden
        Object.values(dataChannels).forEach(dc => {
            if (dc.readyState === 'open') {
                dc.send(message);
            }
        });

        // Lokal anzeigen
        addChatMessage(message, true);
        messageInput.value = '';
    }
}

function handleChatMessage({ message, from }) {
    const participant = getParticipantInfo(from);
    if (participant) {
        addChatMessage(`${participant.username}: ${message}`);
    }
}

function setupDataChannel(dataChannel, userId) {
    dataChannel.onopen = () => {
        console.log(`DataChannel zu ${userId} geöffnet`);
    };

    dataChannel.onclose = () => {
        console.log(`DataChannel zu ${userId} geschlossen`);
    };

    dataChannel.onmessage = (event) => {
        handleChatMessage({ message: event.data, from: userId });
    };
}

// Mediensteuerung
async function toggleScreenShare() {
    try {
        if (!isScreenSharing) {
            screenStream = await navigator.mediaDevices.getDisplayMedia({
                video: true,
                audio: false
            });

            // Alten Video-Track ersetzen
            const videoTrack = screenStream.getVideoTracks()[0];
            const senders = Object.values(peerConnections).map(pc =>
                pc.getSenders().find(s => s.track.kind === 'video')
            );

            for (const sender of senders) {
                if (sender) await sender.replaceTrack(videoTrack);
            }

            // Lokales Video aktualisieren
            localStream.getVideoTracks()[0].stop();
            localStream.removeTrack(localStream.getVideoTracks()[0]);
            localStream.addTrack(videoTrack);

            screenShareButton.innerHTML = '<i class="fas fa-stop"></i>';
            isScreenSharing = true;

            videoTrack.onended = () => toggleScreenShare();
        } else {
            // Zurück zur Kamera
            const cameraStream = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: false
            });
            const cameraTrack = cameraStream.getVideoTracks()[0];

            const senders = Object.values(peerConnections).map(pc =>
                pc.getSenders().find(s => s.track.kind === 'video')
            );

            for (const sender of senders) {
                if (sender) await sender.replaceTrack(cameraTrack);
            }

            // Lokales Video aktualisieren
            screenStream.getTracks().forEach(track => track.stop());
            localStream.removeTrack(localStream.getVideoTracks()[0]);
            localStream.addTrack(cameraTrack);

            screenShareButton.innerHTML = '<i class="fas fa-desktop"></i>';
            isScreenSharing = false;
        }
    } catch (err) {
        console.error('Fehler beim Bildschirmteilen:', err);
    }
}

function toggleMute() {
    const audioTrack = localStream.getAudioTracks()[0];
    if (audioTrack) {
        audioTrack.enabled = !audioTrack.enabled;
        isMuted = !audioTrack.enabled;
        muteButton.innerHTML = isMuted
            ? '<i class="fas fa-microphone-slash"></i>'
            : '<i class="fas fa-microphone"></i>';

        // Video-Info aktualisieren
        const localVideoItem = document.getElementById('video-local');
        if (localVideoItem) {
            const micIcon = localVideoItem.querySelector('.video-info i');
            if (micIcon) {
                micIcon.className = isMuted
                    ? 'fas fa-microphone-slash'
                    : 'fas fa-microphone';
            }
        }
    }
}

function toggleVideo() {
    const videoTrack = localStream.getVideoTracks()[0];
    if (videoTrack) {
        videoTrack.enabled = !videoTrack.enabled;
        isVideoOff = !videoTrack.enabled;
        videoOffButton.innerHTML = isVideoOff
            ? '<i class="fas fa-video-slash"></i>'
            : '<i class="fas fa-video"></i>';
    }
}

async function flipCamera() {
    try {
        const constraints = {
            video: {
                facingMode: localStream.getVideoTracks()[0].getSettings().facingMode === 'user'
                    ? 'environment'
                    : 'user'
            },
            audio: true
        };

        const newStream = await navigator.mediaDevices.getUserMedia(constraints);

        // Alten Stream ersetzen
        localStream.getTracks().forEach(track => track.stop());
        localStream = newStream;

        // Lokales Video aktualisieren
        const localVideo = document.getElementById('local');
        if (localVideo) {
            localVideo.srcObject = localStream;
        }

        // Alle PeerConnections aktualisieren
        Object.values(peerConnections).forEach(pc => {
            const videoSender = pc.getSenders().find(s => s.track.kind === 'video');
            if (videoSender) {
                videoSender.replaceTrack(localStream.getVideoTracks()[0]);
            }
        });
    } catch (err) {
        console.error('Fehler beim Wechseln der Kamera:', err);
    }
}

// Hilfsfunktionen
function getParticipantInfo(userId) {
    const participants = Array.from(participantsList.querySelectorAll('li'));
    const participant = participants.find(li =>
        li.textContent.includes(userId) ||
        (userId === socket.id && li.textContent.includes('(Sie)'))
    );

    if (participant) {
        return {
            username: participant.textContent.replace(' (Sie)', '')
        };
    }
    return null;
}

// Initialisierung
if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost') {
    alert('Diese Anwendung benötigt HTTPS für WebRTC. Bitte verwenden Sie HTTPS oder localhost.');
}