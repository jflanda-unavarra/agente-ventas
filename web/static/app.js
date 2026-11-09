"use strict";

const messages = document.getElementById("messages");
const form = document.getElementById("form");
const input = document.getElementById("input");
const sendBtn = document.getElementById("send");
let conversationId = null;
let busy = false;

// ---- Markdown mínimo (negrita, cursiva, código, listas, tablas, títulos) ----
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
}

function markdown(text) {
  const lines = text.split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1] || "")) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      let html = "<table><thead><tr>" + cells(line).map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>";
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        html += "<tr>" + cells(lines[i]).map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>";
        i++;
      }
      out.push(html + "</tbody></table>");
    } else if (/^\s*[-*]\s+/.test(line)) {
      let html = "<ul>";
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        html += `<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ""))}</li>`;
        i++;
      }
      out.push(html + "</ul>");
    } else if (/^\s*\d+\.\s+/.test(line)) {
      let html = "<ol>";
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        html += `<li>${inline(lines[i].replace(/^\s*\d+\.\s+/, ""))}</li>`;
        i++;
      }
      out.push(html + "</ol>");
    } else if (/^#{1,6}\s/.test(line)) {
      out.push(`<p><strong>${inline(line.replace(/^#{1,6}\s+/, ""))}</strong></p>`);
      i++;
    } else if (line.trim() === "") {
      i++;
    } else {
      const para = [];
      while (i < lines.length && lines[i].trim() !== "" && !/^\s*(\||[-*]\s|\d+\.\s|#)/.test(lines[i])) {
        para.push(inline(lines[i]));
        i++;
      }
      if (para.length) out.push(`<p>${para.join("<br>")}</p>`);
      else i++;
    }
  }
  return out.join("");
}

// ---- UI ----
function addMessage(role, text = "") {
  messages.querySelector(".hint")?.remove();
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (role === "user") bubble.textContent = text;
  wrap.appendChild(bubble);
  messages.appendChild(wrap);
  messages.scrollTop = messages.scrollHeight;
  return bubble;
}

function setBusy(value) {
  busy = value;
  sendBtn.disabled = value;
}

async function ask(text) {
  if (busy || !text.trim()) return;
  setBusy(true);
  addMessage("user", text);
  const bubble = addMessage("bot");
  bubble.classList.add("typing");
  let answer = "";

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: text, conversation_id: conversationId }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const event = /^event: (.*)$/m.exec(raw)?.[1];
        const data = JSON.parse(/^data: (.*)$/m.exec(raw)?.[1] ?? "null");
        if (event === "start") conversationId = data.conversation_id;
        else if (event === "delta") {
          answer += data;
          bubble.innerHTML = markdown(answer);
          messages.scrollTop = messages.scrollHeight;
        } else if (event === "error") {
          bubble.classList.add("error");
          bubble.innerHTML = markdown(answer) + `<p>Error: ${esc(String(data))}</p>`;
        }
      }
    }
  } catch (err) {
    bubble.classList.add("error");
    bubble.textContent = `Error de conexión: ${err.message}`;
  } finally {
    bubble.classList.remove("typing");
    setBusy(false);
    input.focus();
  }
}

form.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value;
  input.value = "";
  input.style.height = "auto";
  ask(text);
});

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = input.scrollHeight + "px";
});

messages.addEventListener("click", (e) => {
  if (e.target.classList.contains("example")) ask(e.target.textContent);
});

document.getElementById("reset").addEventListener("click", async () => {
  if (busy) return;
  if (conversationId) await fetch(`/api/chat/${conversationId}`, { method: "DELETE" }).catch(() => {});
  conversationId = null;
  location.reload();
});
