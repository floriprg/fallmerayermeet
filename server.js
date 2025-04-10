const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

app.use(express.static("."))

const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const rooms = {};

io.on('connection', (socket) => {
    console.log('Neue Verbindung:', socket.id);

    // In der 'join' Event-Behandlung
    socket.on('join', ({ username, room }) => {
        socket.join(room);
        socket.username = username;
        socket.room = room;

        if (!rooms[room]) {
            rooms[room] = { participants: {} };
        }

        // Neuen Teilnehmer hinzufügen
        rooms[room].participants[socket.id] = {
            id: socket.id,
            username: username
        };

        // An alle außer den neuen Teilnehmer senden
        socket.to(room).emit('user-joined', {
            userId: socket.id,
            username: username
        });

        // Aktualisierte Liste an alle senden
        io.to(room).emit('user-list', Object.values(rooms[room].participants));

        console.log(`${username} hat Raum ${room} betreten`);
    });

    // In der 'offer' und 'answer' Behandlung:
    socket.on('offer', ({ offer, to, room }) => {
        socket.to(to).emit('offer', {
            offer,
            from: socket.id,
            username: socket.username // Benutzername mitsenden
        });
    });

    socket.on('answer', ({ answer, to, room }) => {
        socket.to(to).emit('answer', {
            answer,
            from: socket.id,
            username: socket.username
        });
    });

    socket.on('ice-candidate', ({ candidate, to, room }) => {
        socket.to(to).emit('ice-candidate', { candidate, from: socket.id });
    });

    socket.on('chat-message', ({ message, room }) => {
        socket.to(room).emit('chat-message', { message, from: socket.id });
    });

    socket.on('leave', (room) => {
        if (rooms[room]) {
            rooms[room].participants = rooms[room].participants.filter(
                p => p.id !== socket.id
            );

            if (rooms[room].participants.length === 0) {
                delete rooms[room];
            } else {
                io.to(room).emit('user-left', socket.id);
                io.to(room).emit('user-list', rooms[room].participants);
                io.to(room).emit('room-info', {
                    room,
                    participants: rooms[room].participants.length
                });
            }
        }

        socket.leave(room);
        console.log(`Benutzer ${socket.id} hat Raum ${room} verlassen`);
    });

    socket.on('disconnect', () => {
        console.log('Verbindung getrennt:', socket.id);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server läuft auf Port ${PORT}`);
});