const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const { google } = require("googleapis");

require("dotenv").config();

const app = express();
const server = http.createServer(app);

app.use(cors());
app.use(express.json());

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  },
});

let queue = [];
let history = [];
let currentSong = null;
let playbackState = {
  paused: false,
  pausedAt: 0,
};
let chat = [];

function startSong(song) {
  if (!song) {
    currentSong = null;
    return;
  }

  currentSong = {
    ...song,
    startedAt: Date.now(),
    isPlaying: true,
  };
}
function makeId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function extractYouTubeId(text) {
  const patterns = [
    /youtube\.com\/watch\?v=([^&\s]+)/,
    /youtu\.be\/([^?&\s]+)/,
    /youtube\.com\/embed\/([^?&\s]+)/,
    /youtube\.com\/shorts\/([^?&\s]+)/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) return match[1];
  }

  return null;
}

async function searchYouTube(query) {
  const apiKey = process.env.YOUTUBE_API_KEY;

  if (!apiKey) {
    throw new Error("YOUTUBE_API_KEY is missing");
  }

  const youtube = google.youtube({
    version: "v3",
    auth: apiKey,
  });

  const result = await youtube.search.list({
    part: ["snippet"],
    q: query,
    type: ["video"],
    maxResults: 1,
    videoEmbeddable: "true",
  });

  const item = result.data.items?.[0];

  if (!item) {
    throw new Error("No YouTube result");
  }

  return {
    videoId: item.id.videoId,
    title: item.snippet.title,
    channelTitle: item.snippet.channelTitle,
    thumbnail: item.snippet.thumbnails?.medium?.url,
  };
}

function broadcastState() {
io.emit("state", {
  queue,
  history,
  currentSong,
  chat,
  playbackState,
});
}

io.on("connection", (socket) => {
  socket.emit("state", {
    queue,
    history,
    currentSong,
    chat,
  });

  socket.on("sendMessage", async ({ nickname, text }) => {
    const cleanText = String(text || "").trim();
    const user = nickname || "익명";

    if (!cleanText) return;

    const chatMessage = {
      id: makeId(),
      user,
      text: cleanText,
      createdAt: new Date().toISOString(),
    };

    chat.push(chatMessage);
    if (chat.length > 100) chat = chat.slice(-100);

    try {
      if (cleanText.toLowerCase() === "!skip") {
        if (currentSong) {
          history.unshift({
            ...currentSong,
            endedAt: new Date().toISOString(),
            skipped: true,
          });
        }

        startSong(queue.shift() || null);
        broadcastState();
        return;
      }

      if (cleanText.toLowerCase() === "!list") {
        chat.push({
          id: makeId(),
          user: "BOT",
          text: queue.length
            ? queue.map((song, index) => `${index + 1}. ${song.title}`).join(" / ")
            : "예약된 노래가 없습니다.",
          createdAt: new Date().toISOString(),
        });

        broadcastState();
        return;
      }

      let videoId = extractYouTubeId(cleanText);
      let songInfo;

      if (videoId) {
        songInfo = {
          videoId,
          title: `YouTube 영상 ${videoId}`,
          channelTitle: "YouTube",
          thumbnail: `https://img.youtube.com/vi/${videoId}/mqdefault.jpg`,
        };
      } else {
        songInfo = await searchYouTube(cleanText);
      }

      const song = {
        id: makeId(),
        title: songInfo.title,
        videoId: songInfo.videoId,
        channelTitle: songInfo.channelTitle,
        thumbnail: songInfo.thumbnail,
        requestedBy: user,
        query: cleanText,
        createdAt: new Date().toISOString(),
      };

      if (!currentSong) {
        startSong(song);
      } else {
        queue.push(song);
      }

      chat.push({
        id: makeId(),
        user: "BOT",
        text: currentSong.id === song.id
          ? `바로 재생합니다: ${song.title}`
          : `예약 완료: ${song.title}`,
        createdAt: new Date().toISOString(),
      });

      broadcastState();
    } catch (error) {
      chat.push({
        id: makeId(),
        user: "BOT",
        text: `예약 실패: ${error.message}`,
        createdAt: new Date().toISOString(),
      });

      broadcastState();
    }
  });

  socket.on("songEnded", () => {
    if (currentSong) {
      history.unshift({
        ...currentSong,
        endedAt: new Date().toISOString(),
      });
    }

    if (history.length > 100) history = history.slice(0, 100);

    startSong(queue.shift() || null);
    broadcastState();
  });
  socket.on("pauseSong", ({ currentTime }) => {
  playbackState.paused = true;
  playbackState.pausedAt = currentTime;

  io.emit("forcePause", {
    currentTime,
  });

  broadcastState();
});

socket.on("resumeSong", ({ currentTime }) => {
  playbackState.paused = false;

  if (currentSong) {
    currentSong.startedAt = Date.now() - currentTime * 1000;
  }

  io.emit("forcePlay", {
    currentTime,
  });

  broadcastState();
});
});

app.get("/", (req, res) => {
  res.send("SongRoom server is running");
});

const PORT = process.env.PORT || 3001;

server.listen(PORT, () => {
  console.log(`SongRoom server running on port ${PORT}`);
});