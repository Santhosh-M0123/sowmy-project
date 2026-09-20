// Pure client-side dashboard. No auth, no build step, no framework —
// just fetch() against the Flask API served from the same origin.
// icons.js (loaded before this file) provides renderIcon()/hydrateIcons().

const API = "/api";

// ------------------------------------------------------------- helpers --

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString();
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtDuration(seconds) {
  if (seconds === null || seconds === undefined) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function statusBadge(status) {
  const s = (status || "unknown").toLowerCase();
  const label = s.replace(/_/g, " ");
  const variant = s === "completed" ? "badge-solid" : s === "error" ? "badge-outline" : "badge-muted";
  return `<span class="badge ${variant}"><span class="dot"></span>${escapeHtml(label)}</span>`;
}

function skeletonRows(colCount, rowCount) {
  let html = "";
  for (let r = 0; r < rowCount; r++) {
    html += `<tr class="skeleton-row">`;
    for (let c = 0; c < colCount; c++) {
      const width = 35 + ((r * 13 + c * 27) % 45);
      html += `<td><span class="skeleton-bar" style="width:${width}%"></span></td>`;
    }
    html += `</tr>`;
  }
  return html;
}

function showBanner(container, message, onRetry) {
  container.innerHTML = `
    <div class="banner">
      ${renderIcon("alert-triangle")}
      <div class="banner-body">
        <strong>Something went wrong</strong>
        ${escapeHtml(message)}
      </div>
      ${onRetry ? '<button class="btn secondary retry-btn">Retry</button>' : ""}
    </div>
  `;
  if (onRetry) container.querySelector(".retry-btn").addEventListener("click", onRetry);
}

function clearBanner(container) {
  container.innerHTML = "";
}

// ---------------------------------------------------------------- tabs --

document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById(btn.dataset.tab).classList.add("active");

    if (btn.dataset.tab === "dashboard") loadDashboard();
    if (btn.dataset.tab === "agents") loadAgent();
    if (btn.dataset.tab === "call-logs") loadCallLogs();
    // telephony-line is a static status table — nothing to fetch
  });
});

// -------------------------------------------------------- recordings --

function recordingCell(call) {
  if (!call.recording_url) return "—";
  return `<button class="btn-chip play-recording-btn" data-file="${escapeHtml(call._file)}">${renderIcon("headphones", "icon-sm")}Play</button>`;
}

async function playRecording(filename, btn) {
  const original = btn.innerHTML;
  btn.innerHTML = `<span class="spinner"></span>Loading…`;
  btn.disabled = true;
  try {
    const res = await fetch(`${API}/call-logs/${encodeURIComponent(filename)}/recording-url`);
    if (!res.ok) throw new Error((await res.json()).error || "Recording unavailable");
    const data = await res.json();
    window.open(data.url, "_blank", "noopener");
  } catch (err) {
    alert(err.message);
  } finally {
    btn.innerHTML = original;
    btn.disabled = false;
  }
}

function wireRecordingButtons(tbodySelector) {
  document.querySelector(tbodySelector).addEventListener("click", (e) => {
    const btn = e.target.closest(".play-recording-btn");
    if (!btn) return;
    playRecording(btn.dataset.file, btn);
  });
}

wireRecordingButtons("#recent-calls-table tbody");
wireRecordingButtons("#call-logs-table tbody");

// ------------------------------------------------------ transcript modal --

const transcriptModal = document.getElementById("transcript-modal");
const transcriptModalBody = document.getElementById("transcript-modal-body");
const transcriptModalTitle = document.getElementById("transcript-modal-title");
const transcriptModalSub = document.getElementById("transcript-modal-sub");

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

function transcriptCell(call) {
  return `<button class="btn-chip view-transcript-btn" data-file="${escapeHtml(call._file)}" data-label="${escapeHtml(call.caller || call.call_id || "")}">${renderIcon("file-text", "icon-sm")}View</button>`;
}

function renderTranscript(entries) {
  if (!entries || entries.length === 0) {
    transcriptModalBody.innerHTML = `<p class="empty-hint">No transcript available for this call.</p>`;
    return;
  }
  const bubbles = entries
    .map((entry) => {
      const role = entry.role === "user" ? "user" : "assistant";
      return `
        <div class="transcript-bubble ${role}">
          <div class="transcript-meta"><span>${escapeHtml(entry.role || "unknown")}</span><span>${fmtTime(entry.timestamp)}</span></div>
          <div class="transcript-text">${escapeHtml(entry.text || "")}</div>
        </div>
      `;
    })
    .join("");
  transcriptModalBody.innerHTML = `<div class="transcript-thread">${bubbles}</div>`;
}

async function showTranscript(filename, label) {
  transcriptModalTitle.textContent = "Transcript";
  transcriptModalSub.textContent = label || "";
  transcriptModalBody.innerHTML = `<div class="loading-panel"><span class="spinner lg"></span>Loading transcript…</div>`;
  openTranscriptModal();
  try {
    const res = await fetch(`${API}/call-logs/${encodeURIComponent(filename)}/transcript`);
    if (!res.ok) throw new Error((await res.json()).error || "Failed to load transcript");
    const data = await res.json();
    renderTranscript(data.transcripts);
  } catch (err) {
    showBanner(transcriptModalBody, err.message, () => showTranscript(filename, label));
  }
}

document.querySelector("#call-logs-table tbody").addEventListener("click", (e) => {
  const btn = e.target.closest(".view-transcript-btn");
  if (!btn) return;
  showTranscript(btn.dataset.file, btn.dataset.label);
});

// ---------------------------------------------------------- dashboard --

async function loadDashboard() {
  const banner = document.getElementById("dashboard-banner");
  clearBanner(banner);
  const tbody = document.querySelector("#recent-calls-table tbody");
  tbody.innerHTML = skeletonRows(5, 4);
  document.getElementById("recent-calls-empty").hidden = true;

  try {
    const res = await fetch(`${API}/dashboard/summary`);
    if (!res.ok) throw new Error(`Server responded with ${res.status}`);
    const data = await res.json();

    document.getElementById("stat-total-calls").textContent = data.total_calls;
    document.getElementById("stat-calls-today").textContent = data.calls_today;
    document.getElementById("stat-line-status").textContent = data.telephone_line_status;
    document.getElementById("stat-agent-name").textContent = data.agent_name;

    tbody.innerHTML = "";
    document.getElementById("recent-calls-empty").hidden = data.latest_calls.length > 0;
    for (const call of data.latest_calls) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${fmtDate(call.started_at)}</td>
        <td>${call.caller ? escapeHtml(call.caller) : "—"}</td>
        <td>${fmtDuration(call.duration_seconds)}</td>
        <td>${statusBadge(call.status)}</td>
        <td>${recordingCell(call)}</td>
      `;
      tbody.appendChild(tr);
    }
  } catch (err) {
    tbody.innerHTML = "";
    document.getElementById("recent-calls-empty").hidden = true;
    ["stat-total-calls", "stat-calls-today", "stat-line-status", "stat-agent-name"].forEach((id) => {
      document.getElementById(id).textContent = "—";
    });
    showBanner(banner, err.message, loadDashboard);
  }
}

// -------------------------------------------------------------- agents --

const TEMPLATES = [
  {
    id: "college",
    name: "College Front Desk",
    icon: "graduation-cap",
    description: "Admissions, timings, fees, exam schedules, department routing.",
    prompt: `You are the voice assistant for a college front-desk phone line.

Greet the caller warmly, figure out what they need — admissions, class
timings, fees, exam schedules, or being routed to the right department — and
answer clearly and briefly.

Guidelines:
- Keep responses short and conversational; this is a phone call, not a chat.
- If you don't know something, say so honestly instead of guessing.
- Be patient and easy to understand, especially with dates, times, and fees.
- Offer to connect the caller to a human staff member for anything you can't resolve.`,
  },
  {
    id: "hotel",
    name: "Hotel Receptionist",
    icon: "building",
    description: "Reservations, room availability, check-in/out, amenities.",
    prompt: `You are the voice receptionist for a hotel's front desk phone line.

Greet callers warmly and help with reservations, room availability, check-in
and check-out times, amenities, and local recommendations. Confirm dates and
the number of guests clearly before treating anything as booked.

Guidelines:
- Keep responses short, warm, and professional — like a well-trained concierge.
- Always repeat back dates, room type, and guest count to confirm details.
- If a request needs a human (billing disputes, complaints, group bookings),
  offer to transfer the call.
- Never confirm a reservation as final; say a team member will confirm by email.`,
  },
  {
    id: "dental",
    name: "Dental Receptionist",
    icon: "cross",
    description: "Book, reschedule, or cancel appointments; basic clinic info.",
    prompt: `You are the voice receptionist for a dental clinic's phone line.

Help callers book, reschedule, or cancel appointments, answer basic questions
about services and office hours, and collect the information the front desk
needs (name, reason for visit, preferred date/time, insurance if mentioned).

Guidelines:
- Be calm, friendly, and reassuring — many callers are anxious about dental visits.
- Never give medical advice or diagnose symptoms; for anything urgent or
  painful, advise the caller to seek immediate care or connect them to staff.
- Confirm the appointment date and time back to the caller before ending the call.
- Keep responses short and clear.`,
  },
  {
    id: "restaurant",
    name: "Restaurant Reservations",
    icon: "utensils",
    description: "Table bookings, party size, hours, dietary questions.",
    prompt: `You are the voice assistant for a restaurant's reservation line.

Help callers book a table, ask about party size, date, and time, and answer
quick questions about hours, location, and whether the restaurant can
accommodate dietary restrictions or large groups.

Guidelines:
- Keep the tone friendly and upbeat, like a great host greeting guests.
- Always confirm party size, date, and time back to the caller.
- If the restaurant is full or the request is unusual (private events, large
  parties), offer to have someone call back.
- Keep responses brief — this is a phone call, not a menu recitation.`,
  },
  {
    id: "salon",
    name: "Salon & Spa Booking",
    icon: "scissors",
    description: "Appointment scheduling for stylists and spa treatments.",
    prompt: `You are the voice assistant for a hair salon and spa's booking line.

Help callers schedule appointments for services like haircuts, coloring,
manicures, or spa treatments, and answer basic questions about pricing,
stylists, and availability.

Guidelines:
- Be warm and welcoming, and keep the pace relaxed but efficient.
- Confirm the service, preferred stylist (if any), and date/time back to the caller.
- If you're unsure which service fits what the caller describes, ask a
  clarifying question rather than guessing.
- Offer to transfer to the front desk for anything requiring a manager.`,
  },
  {
    id: "real-estate",
    name: "Real Estate Inquiries",
    icon: "home",
    description: "Listing questions, viewings, lead capture for agents.",
    prompt: `You are the voice assistant for a real estate agency's phone line.

Help callers with questions about property listings, schedule viewings, and
capture contact details for agents to follow up. Ask about budget, location,
and property type to route the inquiry well.

Guidelines:
- Be professional, upbeat, and never pressure the caller.
- Never quote a final price or confirm a sale — always say pricing and
  availability will be confirmed by an agent.
- Collect the caller's name and callback number for any inquiry you can't
  fully resolve.
- Keep responses concise and conversational.`,
  },
  {
    id: "auto-repair",
    name: "Auto Repair Shop",
    icon: "wrench",
    description: "Service booking, turnaround estimates, basic service info.",
    prompt: `You are the voice assistant for an auto repair shop's phone line.

Help callers book a service appointment, get a rough idea of turnaround time,
and answer basic questions about services offered (oil changes, brakes,
tires, diagnostics). Ask for the vehicle make/model and the issue they're
experiencing.

Guidelines:
- Be direct, friendly, and reassuring — car trouble is stressful for most callers.
- Never quote an exact repair price over the phone; say a technician will
  give an estimate after inspection.
- Confirm the appointment date/time and vehicle details back to the caller.
- Keep responses short and practical.`,
  },
  {
    id: "law-firm",
    name: "Law Firm Front Desk",
    icon: "briefcase",
    description: "Intake, consultation scheduling, attorney routing.",
    prompt: `You are the voice assistant for a law firm's front-desk phone line.

Greet callers professionally, understand the general nature of their legal
need (without giving legal advice), and either schedule a consultation or
route them to the right attorney or paralegal.

Guidelines:
- Be calm, professional, and discreet — many callers are dealing with
  sensitive situations.
- Never give legal advice or opinions on a case; only the attorneys do that.
- Collect the caller's name, callback number, and a brief description of
  their need for the intake team.
- Keep responses brief, respectful, and free of legal jargon.`,
  },
];

function renderTemplateGrid() {
  const grid = document.getElementById("template-grid");
  grid.innerHTML = TEMPLATES.map(
    (t) => `
      <button type="button" class="template-card" data-template-id="${t.id}">
        <div class="template-top">
          <div class="template-icon">${renderIcon(t.icon)}</div>
          ${t.id === "college" ? '<span class="template-badge">Default</span>' : ""}
        </div>
        <div class="template-name">${escapeHtml(t.name)}</div>
        <div class="template-desc">${escapeHtml(t.description)}</div>
      </button>
    `
  ).join("");

  grid.querySelectorAll(".template-card").forEach((card) => {
    card.addEventListener("click", () => selectTemplate(card.dataset.templateId));
  });
}

function selectTemplate(id) {
  const template = TEMPLATES.find((t) => t.id === id);
  if (!template) return;

  document.querySelectorAll(".template-card").forEach((card) => {
    card.classList.toggle("selected", card.dataset.templateId === id);
  });

  const editor = document.getElementById("system-prompt-editor");
  editor.disabled = false;
  editor.value = template.prompt;

  const hint = document.getElementById("template-hint");
  hint.hidden = false;
  hint.innerHTML = `${renderIcon("check", "icon-sm")}Loaded "${escapeHtml(template.name)}" — review it below, then Save to apply.`;
}

async function loadAgent() {
  const banner = document.getElementById("agent-banner");
  clearBanner(banner);
  const editor = document.getElementById("system-prompt-editor");
  editor.disabled = true;
  editor.value = "";
  editor.placeholder = "Loading current prompt…";
  document.getElementById("agent-name-display").innerHTML = `<span class="spinner"></span>`;
  document.getElementById("agent-prompt-updated").innerHTML = `<span class="spinner"></span>`;

  try {
    const [agentRes, promptRes] = await Promise.all([fetch(`${API}/agent`), fetch(`${API}/system-prompt`)]);
    if (!agentRes.ok || !promptRes.ok) throw new Error("Server error while loading agent config");
    const agent = await agentRes.json();
    const prompt = await promptRes.json();

    document.getElementById("agent-name-display").textContent = agent.agent_name;
    document.getElementById("agent-prompt-updated").textContent = fmtDate(prompt.updated_at);
    editor.value = prompt.content;
    editor.disabled = false;
  } catch (err) {
    document.getElementById("agent-name-display").textContent = "—";
    document.getElementById("agent-prompt-updated").textContent = "—";
    editor.placeholder = "Couldn't load the current prompt.";
    showBanner(banner, err.message, loadAgent);
  }
}

document.getElementById("save-prompt-btn").addEventListener("click", async () => {
  const content = document.getElementById("system-prompt-editor").value;
  const status = document.getElementById("save-prompt-status");
  const btn = document.getElementById("save-prompt-btn");
  if (!content.trim()) {
    status.className = "save-status error";
    status.innerHTML = `${renderIcon("alert-triangle", "icon-sm")}Prompt can't be empty.`;
    return;
  }
  btn.disabled = true;
  status.className = "save-status";
  status.innerHTML = `<span class="spinner"></span>Saving…`;
  try {
    const res = await fetch(`${API}/system-prompt`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) throw new Error((await res.json()).error || "Save failed");
    status.className = "save-status success";
    status.innerHTML = `${renderIcon("check", "icon-sm")}Saved — next call uses this prompt.`;
    loadAgent();
  } catch (err) {
    status.className = "save-status error";
    status.innerHTML = `${renderIcon("alert-triangle", "icon-sm")}${escapeHtml(err.message)}`;
  } finally {
    btn.disabled = false;
  }
});

// ----------------------------------------------------------- call logs --

async function loadCallLogs() {
  const banner = document.getElementById("call-logs-banner");
  clearBanner(banner);
  const tbody = document.querySelector("#call-logs-table tbody");
  tbody.innerHTML = skeletonRows(7, 5);
  document.getElementById("call-logs-empty").hidden = true;

  try {
    const res = await fetch(`${API}/call-logs`);
    if (!res.ok) throw new Error(`Server responded with ${res.status}`);
    const logs = await res.json();

    tbody.innerHTML = "";
    document.getElementById("call-logs-empty").hidden = logs.length > 0;
    for (const call of logs) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${fmtDate(call.started_at)}</td>
        <td>${fmtDate(call.ended_at)}</td>
        <td>${fmtDuration(call.duration_seconds)}</td>
        <td>${call.caller ? escapeHtml(call.caller) : "—"}</td>
        <td>${statusBadge(call.status)}</td>
        <td>${recordingCell(call)}</td>
        <td>${transcriptCell(call)}</td>
      `;
      tbody.appendChild(tr);
    }
  } catch (err) {
    tbody.innerHTML = "";
    document.getElementById("call-logs-empty").hidden = true;
    showBanner(banner, err.message, loadCallLogs);
  }
}

// ------------------------------------------------------------------ init --

hydrateIcons();
renderTemplateGrid();
loadDashboard();
