import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";

const MAX_MESSAGE_LENGTH = 500;
const MAX_MESSAGES_IN_VIEW = 300;
const THEME_STORAGE_KEY = "chatter-theme";
const STATUS_LABELS = {
  connected: "Connected",
  connecting: "Connecting…",
  offline: "Offline",
};

// The inline script in index.html applies the stored/system theme before React
// mounts, so read it back here instead of resolving it a second time.
function readTheme() {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function ThemeToggle({ theme, onToggle }) {
  const nextTheme = theme === "dark" ? "light" : "dark";
  return (
    <button
      type="button"
      className="theme-toggle"
      data-theme={theme}
      onClick={onToggle}
      aria-label={`Switch to ${nextTheme} mode`}
      aria-pressed={theme === "dark"}
    >
      <span className="theme-icon" aria-hidden="true">
        <svg
          className="icon-sun"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
        >
          <circle cx="12" cy="12" r="4.2" />
          <path d="M12 2.6v2.1M12 19.3v2.1M2.6 12h2.1M19.3 12h2.1M5.4 5.4l1.5 1.5M17.1 17.1l1.5 1.5M18.6 5.4l-1.5 1.5M6.9 17.1l-1.5 1.5" />
        </svg>
        <svg
          className="icon-moon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M20.7 14.6A8.6 8.6 0 0 1 9.4 3.3 8.6 8.6 0 1 0 20.7 14.6Z" />
        </svg>
      </span>
    </button>
  );
}

function appendMessage(messages, message) {
  return [...messages.slice(-(MAX_MESSAGES_IN_VIEW - 1)), message];
}

function systemMessage(text) {
  return {
    id: `system-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    system: true,
    text,
  };
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function App() {
  const socketRef = useRef(null);
  const nicknameRef = useRef("");
  const messageListRef = useRef(null);

  const [status, setStatus] = useState("connecting");
  const [selfId, setSelfId] = useState("");
  const [nickname, setNickname] = useState("");
  const [nicknameDraft, setNicknameDraft] = useState("");
  const [view, setView] = useState("nickname");
  const [room, setRoom] = useState(null);
  const [messages, setMessages] = useState([]);
  const [online, setOnline] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [code, setCode] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [theme, setTheme] = useState(readTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {
      // Storage can be unavailable (private mode); the theme still applies.
    }
  }, [theme]);

  useEffect(() => {
    // In production VITE_SERVER_URL points to the Railway backend.
    // Locally it is undefined and io() falls back to same-origin (Vite proxy).
    const serverUrl = import.meta.env.VITE_SERVER_URL || "";
    const socket = io(serverUrl, { path: "/socket.io" });
    socketRef.current = socket;

    const addMessage = (message) =>
      setMessages((current) => appendMessage(current, message));

    function handleConnect() {
      setStatus("connected");
      setSelfId(socket.id);

      // A reconnect creates a fresh server-side session. Re-register the
      // nickname and send the user back to the lobby.
      if (!nicknameRef.current) return;
      socket.timeout(8000).emit(
        "join",
        { nickname: nicknameRef.current },
        (timeoutError, response) => {
          if (timeoutError || !response?.ok) {
            nicknameRef.current = "";
            setNickname("");
            setView("nickname");
            setError("Your session expired. Please pick a nickname again.");
            return;
          }
          setRoom(null);
          setMessages([]);
          setOnline(null);
          setBusy(false);
          setView("lobby");
          setNotice("Reconnected — you are back in the lobby.");
        }
      );
    }

    socket.on("connect", handleConnect);
    socket.on("disconnect", (reason) => {
      setStatus(reason === "io client disconnect" ? "offline" : "connecting");
    });
    socket.on("connect_error", () => setStatus("connecting"));
    socket.on("message", addMessage);
    socket.on("notice", ({ text }) => addMessage(systemMessage(text)));
    socket.on("presence", ({ count }) => setOnline(count));

    socket.on("random:waiting", () => {
      setRoom(null);
      setMessages([]);
      setBusy(false);
      setView("waiting");
    });

    socket.on("random:matched", ({ partner }) => {
      setRoom({ type: "random", partner });
      setMessages([]);
      setOnline(2);
      setError("");
      setBusy(false);
      setView("chat");
    });

    socket.on("random:partner-left", ({ message }) => {
      setRoom(null);
      setMessages([]);
      setBusy(false);
      setView("lobby");
      setNotice(message || "Your partner left the chat.");
    });

    socket.on("random:timeout", ({ message }) => {
      setRoom(null);
      setMessages([]);
      setBusy(false);
      setView("lobby");
      setNotice(message || "No one showed up in time.");
    });

    socket.on("room:closed", ({ message }) => {
      setRoom(null);
      setMessages([]);
      setBusy(false);
      setView("lobby");
      setNotice(message || "That room was closed.");
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);

  useEffect(() => {
    const list = messageListRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages, view]);

  function emit(event, payload = {}) {
    return new Promise((resolve) => {
      const socket = socketRef.current;
      if (!socket?.connected) {
        resolve({ ok: false, error: "Not connected to the server." });
        return;
      }
      socket.timeout(8000).emit(event, payload, (timeoutError, response) => {
        if (timeoutError) {
          resolve({ ok: false, error: "The server did not respond. Try again." });
          return;
        }
        resolve(response ?? { ok: false, error: "Unexpected server response." });
      });
    });
  }

  async function handleNicknameSubmit(event) {
    event.preventDefault();
    const value = nicknameDraft.trim();
    if (!value || busy) return;
    setBusy(true);
    setError("");
    const response = await emit("join", { nickname: value });
    setBusy(false);
    if (!response.ok) {
      setError(response.error);
      return;
    }
    nicknameRef.current = response.nickname;
    setNickname(response.nickname);
    setNicknameDraft(response.nickname);
    setNotice("");
    setView("lobby");
  }

  async function handlePublicChat() {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    setMessages([]);
    setOnline(null);
    const response = await emit("room:public");
    setBusy(false);
    if (!response.ok) {
      setError(response.error);
      return;
    }
    setRoom({ type: "public" });
    setOnline(response.count);
    setView("chat");
  }

  async function handleCreateRoom() {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    setMessages([]);
    setOnline(null);
    const response = await emit("room:create");
    setBusy(false);
    if (!response.ok) {
      setError(response.error);
      return;
    }
    setRoom({ type: "private", code: response.code });
    setOnline(response.count);
    setView("chat");
  }

  async function handleJoinRoom(event) {
    event.preventDefault();
    if (busy || code.length !== 6) return;
    setBusy(true);
    setError("");
    setNotice("");
    setMessages([]);
    setOnline(null);
    const response = await emit("room:join", { code });
    setBusy(false);
    if (!response.ok) {
      setError(response.error);
      return;
    }
    setRoom({ type: "private", code: response.code });
    setOnline(response.count);
    setCode("");
    setView("chat");
  }

  async function handleFindStranger() {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    setMessages([]);
    setOnline(null);
    setRoom(null);
    setView("waiting");
    const response = await emit("random:find");
    setBusy(false);
    if (!response.ok) {
      setView("lobby");
      setError(response.error);
    }
  }

  async function handleCancelWaiting() {
    await emit("random:leave");
    setRoom(null);
    setMessages([]);
    setView("lobby");
  }

  async function handleNextStranger() {
    setError("");
    setDraft("");
    setMessages([]);
    setView("waiting");
    const response = await emit("random:next");
    if (!response.ok) {
      setRoom(null);
      setView("lobby");
      setError(response.error);
    }
  }

  async function handleEndRandom() {
    await emit("random:leave");
    setRoom(null);
    setMessages([]);
    setDraft("");
    setView("lobby");
    setNotice("You left the random chat.");
  }

  async function handleLeaveRoom() {
    await emit("room:leave");
    setRoom(null);
    setMessages([]);
    setDraft("");
    setView("lobby");
    setNotice("You left the room.");
  }

  async function handleSend(event) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !room) return;
    setError("");
    setDraft("");
    const response = await emit("message:send", { text });
    if (!response.ok) {
      setError(response.error);
      setDraft((current) => (current.trim() ? current : text));
    }
  }

  async function handleCopyCode() {
    if (!room?.code) return;
    try {
      await navigator.clipboard.writeText(room.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Could not copy the code. Select it manually.");
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            #
          </span>
          Chatter
        </div>
        <div className="topbar-actions">
          <div className={`status status-${status}`} role="status">
            <span className="dot" aria-hidden="true" />
            {STATUS_LABELS[status]}
          </div>
          <ThemeToggle
            theme={theme}
            onToggle={() =>
              setTheme((current) => (current === "dark" ? "light" : "dark"))
            }
          />
        </div>
      </header>

      <main className="main">
        {view === "nickname" && (
          <section className="panel nickname-panel">
            <h1>Pick a nickname</h1>
            <p className="muted">
              No account, no history. Messages live in server memory and vanish
              when the server restarts.
            </p>
            <form className="stack" onSubmit={handleNicknameSubmit}>
              <label htmlFor="nickname">Nickname</label>
              <input
                id="nickname"
                value={nicknameDraft}
                onChange={(event) => {
                  setNicknameDraft(event.target.value);
                  setError("");
                }}
                maxLength={16}
                autoComplete="off"
                autoFocus
                placeholder="e.g. sunny"
              />
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <button
                type="submit"
                className="primary"
                disabled={busy || !nicknameDraft.trim() || status !== "connected"}
              >
                Start chatting
              </button>
            </form>
          </section>
        )}

        {view === "lobby" && (
          <section className="lobby">
            <div className="lobby-head">
              <h1>Hi, {nickname}</h1>
              <p className="muted">Choose how you want to chat.</p>
              {notice && (
                <p className="notice" role="status">
                  {notice}
                </p>
              )}
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
            </div>

            <div className="cards">
              <article className="card">
                <h2>Public chat</h2>
                <p className="muted">One shared room for everyone online.</p>
                <button
                  type="button"
                  className="primary"
                  onClick={handlePublicChat}
                  disabled={busy || status !== "connected"}
                >
                  Join public chat
                </button>
              </article>

              <article className="card">
                <h2>Private room</h2>
                <p className="muted">
                  Create a room and share its 6-character code. Only people
                  with the code can join.
                </p>
                <button
                  type="button"
                  className="secondary"
                  onClick={handleCreateRoom}
                  disabled={busy || status !== "connected"}
                >
                  Create a room
                </button>
                <form className="join-form" onSubmit={handleJoinRoom}>
                  <label className="sr-only" htmlFor="room-code">
                    Room code
                  </label>
                  <input
                    id="room-code"
                    value={code}
                    onChange={(event) =>
                      setCode(
                        event.target.value
                          .toUpperCase()
                          .replace(/[^A-Z0-9]/g, "")
                          .slice(0, 6)
                      )
                    }
                    placeholder="Room code"
                    maxLength={6}
                    autoComplete="off"
                  />
                  <button
                    type="submit"
                    className="secondary"
                    disabled={
                      busy || code.length !== 6 || status !== "connected"
                    }
                  >
                    Join
                  </button>
                </form>
              </article>

              <article className="card">
                <h2>Random chat</h2>
                <p className="muted">
                  Get matched one-on-one with another waiting stranger.
                </p>
                <button
                  type="button"
                  className="primary"
                  onClick={handleFindStranger}
                  disabled={busy || status !== "connected"}
                >
                  Find stranger
                </button>
              </article>
            </div>
          </section>
        )}

        {view === "waiting" && (
          <section className="panel waiting-panel">
            <h1>Looking for a stranger…</h1>
            <p className="muted">
              You will be connected as soon as someone else is waiting.
            </p>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <button
              type="button"
              className="secondary"
              onClick={handleCancelWaiting}
            >
              Cancel
            </button>
          </section>
        )}

        {view === "chat" && room && (
          <section className="panel chat-panel">
            <header className="chat-head">
              <div className="chat-title">
                <h1>
                  {room.type === "public" && "Public chat"}
                  {room.type === "private" && `Room ${room.code}`}
                  {room.type === "random" && `Chatting with ${room.partner}`}
                </h1>
                <p className="muted">
                  {room.type === "public" &&
                    `${online ?? 0} ${online === 1 ? "person" : "people"} online`}
                  {room.type === "private" &&
                    `${online ?? 1} ${
                      online === 1 ? "person" : "people"
                    } in this room`}
                  {room.type === "random" && "Random chat"}
                </p>
              </div>

              <div className="chat-actions">
                {room.type === "private" && (
                  <button
                    type="button"
                    className="ghost code-button"
                    onClick={handleCopyCode}
                    title="Copy room code"
                  >
                    {copied ? "Copied" : `Code ${room.code}`}
                  </button>
                )}
                {room.type === "random" ? (
                  <>
                    <button
                      type="button"
                      className="secondary"
                      onClick={handleNextStranger}
                    >
                      Next
                    </button>
                    <button
                      type="button"
                      className="ghost"
                      onClick={handleEndRandom}
                    >
                      Disconnect
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    className="ghost"
                    onClick={handleLeaveRoom}
                  >
                    Leave
                  </button>
                )}
              </div>
            </header>

            <div
              className="messages"
              ref={messageListRef}
              aria-live="polite"
              aria-label="Messages"
            >
              {messages.length === 0 && (
                <p className="empty">No messages yet. Say hello.</p>
              )}
              {messages.map((message) =>
                message.system ? (
                  <p className="system" key={message.id}>
                    {message.text}
                  </p>
                ) : (
                  <div
                    className={`message ${
                      message.fromId === selfId ? "mine" : ""
                    }`}
                    key={message.id}
                  >
                    <div className="meta">
                      {message.from}
                      <span>{formatTime(message.ts)}</span>
                    </div>
                    <div className="bubble">{message.text}</div>
                  </div>
                )
              )}
            </div>

            {error && (
              <p className="error chat-error" role="alert">
                {error}
              </p>
            )}

            <form className="composer" onSubmit={handleSend}>
              <input
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                maxLength={MAX_MESSAGE_LENGTH}
                placeholder="Write a message…"
                aria-label="Message"
                autoComplete="off"
              />
              <button
                type="submit"
                className="primary"
                disabled={!draft.trim() || status !== "connected"}
              >
                Send
              </button>
            </form>
          </section>
        )}
      </main>
    </div>
  );
}
