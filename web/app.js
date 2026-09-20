// Pure client-side dashboard. No auth, no build step, no framework —
// just fetch() against the Flask API served from the same origin.

const API = "/api";

// ---------------------------------------------------------------- tabs --

document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");

    if (btn.dataset.tab === "dashboard") loadDashboard();
    if (btn.dataset.tab === "agents") loadAgent();
    if (btn.dataset.tab === "call-logs") loadCallLogs();
    if (btn.dataset.tab === "telephony-line") loadTelephoneLine();
  });
});

// ------------------------------------------------------------- helpers --

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString();
}

function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function recordingLink(url) {
  if (!url) return "—";
  return `<a href="${url}" target="_blank" rel="noopener">recording</a>`;
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// ------------------------------------------------------ transcript modal --

const transcriptModal = document.getElementById("transcript-modal");
const transcriptModalBody = document.getElementById("transcript-modal-body");
const transcriptModalTitle = document.getElementById("transcript-modal-title");

function openTranscriptModal() {
  transcriptModal.hidden = false;
}

function closeTranscriptModal() {
  transcriptModal.hidden = true;
  transcriptModalBody.innerHTML = "";
}

document.getElementById("transcript-modal-close").addEventListener("click", closeTranscriptModal);
transcriptModal.addEventListener("click", (e) => {
  if (e.target === transcriptModal) closeTranscriptModal();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !transcriptModal.hidden) closeTranscriptModal();
});

function renderTranscript(entries) {
  if (!entries || entries.length === 0) {
    transcriptModalBody.innerHTML = `<p class="empty-hint">No transcript available for this call.</p>`;
    return;
  }
  transcriptModalBody.innerHTML = entries
    .map((entry) => `
      <div class="transcript-line role-${escapeHtml(entry.role || "unknown")}">
        <div class="transcript-meta">
          <span class="transcript-role">${escapeHtml(entry.role || "unknown")}</span>
          <span class="transcript-time">${fmtDate(entry.timestamp)}</span>
        </div>
        <div class="transcript-text">${escapeHtml(entry.text || "")}</div>
      </div>
    `)
    .join("");
}

async function showTranscript(filename, label) {
  transcriptModalTitle.textContent = label ? `Transcript — ${label}` : "Transcript";
  transcriptModalBody.innerHTML = `<p class="empty-hint">Loading…</p>`;
  openTranscriptModal();
  try {
    const res = await fetch(`${API}/call-logs/${encodeURIComponent(filename)}/transcript`);
    if (!res.ok) throw new Error("Failed to load transcript");
    const data = await res.json();
    renderTranscript(data.transcripts);
  } catch (err) {
    transcriptModalBody.innerHTML = `<p class="empty-hint">${escapeHtml(err.message)}</p>`;
  }
}

// ---------------------------------------------------------- dashboard --

async function loadDashboard() {
  const res = await fetch(`${API}/dashboard/summary`);
  const data = await res.json();

  document.getElementById("stat-total-calls").textContent = data.total_calls;
  document.getElementById("stat-calls-today").textContent = data.calls_today;
  document.getElementById("stat-line-status").textContent = data.telephone_line_status;
  document.getElementById("stat-agent-name").textContent = data.agent_name;

  const tbody = document.querySelector("#recent-calls-table tbody");
  tbody.innerHTML = "";
  document.getElementById("recent-calls-empty").hidden = data.latest_calls.length > 0;

  for (const call of data.latest_calls) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${fmtDate(call.started_at)}</td>
      <td>${call.caller || "—"}</td>
      <td>${fmtDuration(call.duration_seconds)}</td>
      <td>${call.status || "—"}</td>
      <td>${recordingLink(call.recording_url)}</td>
    `;
    tbody.appendChild(tr);
  }
}

// -------------------------------------------------------------- agents --

async function loadAgent() {
  const [agentRes, promptRes] = await Promise.all([
    fetch(`${API}/agent`),
    fetch(`${API}/system-prompt`),
  ]);
  const agent = await agentRes.json();
  const prompt = await promptRes.json();

  document.getElementById("agent-name-display").textContent = agent.agent_name;
  document.getElementById("agent-prompt-updated").textContent = fmtDate(prompt.updated_at);
  document.getElementById("system-prompt-editor").value = prompt.content;
}

document.getElementById("save-prompt-btn").addEventListener("click", async () => {
  const content = document.getElementById("system-prompt-editor").value;
  const status = document.getElementById("save-prompt-status");
  status.textContent = "Saving…";
  status.classList.remove("error");
  try {
    const res = await fetch(`${API}/system-prompt`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) throw new Error((await res.json()).error || "Save failed");
    status.textContent = "Saved — next call will use this prompt.";
    loadAgent();
  } catch (err) {
    status.textContent = err.message;
    status.classList.add("error");
  }
});

// ----------------------------------------------------------- call logs --

async function loadCallLogs() {
  const res = await fetch(`${API}/call-logs`);
  const logs = await res.json();

  const tbody = document.querySelector("#call-logs-table tbody");
  tbody.innerHTML = "";
  document.getElementById("call-logs-empty").hidden = logs.length > 0;

  for (const call of logs) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${fmtDate(call.started_at)}</td>
      <td>${fmtDate(call.ended_at)}</td>
      <td>${fmtDuration(call.duration_seconds)}</td>
      <td>${call.caller || "—"}</td>
      <td>${call.status || "—"}</td>
      <td>${recordingLink(call.recording_url)}</td>
      <td><button class="btn-link view-transcript-btn" data-file="${escapeHtml(call._file)}" data-label="${escapeHtml(call.caller || call.call_id || "")}">View</button></td>
    `;
    tbody.appendChild(tr);
  }
}

document.querySelector("#call-logs-table tbody").addEventListener("click", (e) => {
  const btn = e.target.closest(".view-transcript-btn");
  if (!btn) return;
  showTranscript(btn.dataset.file, btn.dataset.label);
});

// ------------------------------------------------------- telephony line --

async function loadTelephoneLine() {
  const res = await fetch(`${API}/telephone-line`);
  const line = await res.json();

  document.getElementById("line-phone-number").value = line.phone_number || "";
  document.getElementById("line-sip-trunk-id").value = line.sip_trunk_id || "";
  document.getElementById("line-agent-name").value = line.agent_name || "";
  document.getElementById("line-status").value = line.status || "unassigned";
  document.getElementById("line-notes").value = line.notes || "";
  document.getElementById("line-updated-at").textContent = fmtDate(line.updated_at);
}

document.getElementById("save-line-btn").addEventListener("click", async () => {
  const status = document.getElementById("save-line-status");
  status.textContent = "Saving…";
  status.classList.remove("error");
  const payload = {
    phone_number: document.getElementById("line-phone-number").value,
    sip_trunk_id: document.getElementById("line-sip-trunk-id").value,
    agent_name: document.getElementById("line-agent-name").value,
    status: document.getElementById("line-status").value,
    notes: document.getElementById("line-notes").value,
  };
  try {
    const res = await fetch(`${API}/telephone-line`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error((await res.json()).error || "Save failed");
    const line = await res.json();
    document.getElementById("line-updated-at").textContent = fmtDate(line.updated_at);
    status.textContent = "Saved.";
  } catch (err) {
    status.textContent = err.message;
    status.classList.add("error");
  }
});

// ------------------------------------------------------------------ init --

loadDashboard();
