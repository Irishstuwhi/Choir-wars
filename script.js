// FamJam Board - realtime family tasks using Firebase Firestore
// 1) Create a Firebase project
// 2) Enable Firestore Database
// 3) Paste your firebaseConfig below
// 4) Set Firestore rules for testing (see instructions in this message)

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getFirestore,
  collection,
  addDoc,
  doc,
  deleteDoc,
  updateDoc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
  where,
  getDocs,
  writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

/** ✅ PASTE YOUR FIREBASE CONFIG HERE **/
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// UI refs
const boardIdEl = document.getElementById("boardId");
const joinBtn = document.getElementById("joinBtn");
const displayNameEl = document.getElementById("displayName");
const taskForm = document.getElementById("taskForm");
const taskTitleEl = document.getElementById("taskTitle");
const assigneeEl = document.getElementById("assignee");
const dueDateEl = document.getElementById("dueDate");
const priorityEl = document.getElementById("priority");
const taskListEl = document.getElementById("taskList");
const statusNoteEl = document.getElementById("statusNote");
const footerInfoEl = document.getElementById("footerInfo");
const clearDoneBtn = document.getElementById("clearDoneBtn");
const statusFilterEl = document.getElementById("statusFilter");
const sortByEl = document.getElementById("sortBy");

let currentBoard = null;
let unsubscribe = null;

const LS_KEYS = {
  board: "famjam_board",
  name: "famjam_name",
  statusFilter: "famjam_statusFilter",
  sortBy: "famjam_sortBy"
};

function sanitizeBoardId(raw) {
  // Firestore doc ids can include many chars, but keep it simple for humans.
  // Uppercase, trim, and swap spaces to dashes.
  return (raw || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "-")
    .replace(/[^A-Z0-9-_]/g, "");
}

function setNote(msg) {
  statusNoteEl.textContent = msg || "";
}

function setFooter(msg) {
  footerInfoEl.textContent = msg || "";
}

function formatDue(dueDateStr) {
  if (!dueDateStr) return "No due date";
  return `Due: ${dueDateStr}`;
}

function prettyStatus(s) {
  if (s === "open") return "Open";
  if (s === "doing") return "Doing";
  if (s === "done") return "Done";
  return s || "Open";
}

function priorityRank(p) {
  if (p === "high") return 3;
  if (p === "med") return 2;
  return 1;
}

function loadPrefs() {
  const savedBoard = localStorage.getItem(LS_KEYS.board);
  const savedName = localStorage.getItem(LS_KEYS.name);
  const savedStatus = localStorage.getItem(LS_KEYS.statusFilter);
  const savedSort = localStorage.getItem(LS_KEYS.sortBy);

  if (savedBoard) boardIdEl.value = savedBoard;
  if (savedName) displayNameEl.value = savedName;
  if (savedStatus) statusFilterEl.value = savedStatus;
  if (savedSort) sortByEl.value = savedSort;
}

function savePrefs() {
  localStorage.setItem(LS_KEYS.board, boardIdEl.value);
  localStorage.setItem(LS_KEYS.name, displayNameEl.value);
  localStorage.setItem(LS_KEYS.statusFilter, statusFilterEl.value);
  localStorage.setItem(LS_KEYS.sortBy, sortByEl.value);
}

function renderEmpty(msg) {
  taskListEl.innerHTML = `<div class="empty">${msg}</div>`;
}

function cardHTML(t) {
  const who = t.assignee ? `Assigned: ${escapeHtml(t.assignee)}` : "Unassigned";
  const by = t.createdBy ? ` • Added by: ${escapeHtml(t.createdBy)}` : "";
  const due = formatDue(t.dueDate);
  const status = prettyStatus(t.status || "open");
  const pr = t.priority || "med";

  return `
    <div class="card">
      <div class="cardTop">
        <div>
          <div class="taskTitle">${escapeHtml(t.title)}</div>
          <div class="meta">${who} • ${due} • Status: ${status}${by}</div>
        </div>
        <div class="badges">
          <span class="badge ${pr}">${pr.toUpperCase()}</span>
        </div>
      </div>

      <div class="actions">
        <button class="actionBtn good" data-act="open" data-id="${t.id}">Open</button>
        <button class="actionBtn warn" data-act="doing" data-id="${t.id}">Doing</button>
        <button class="actionBtn good" data-act="done" data-id="${t.id}">Done</button>
        <button class="actionBtn bad" data-act="delete" data-id="${t.id}">Delete</button>
      </div>
    </div>
  `;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function getTasksCollection(board) {
  // Structure: boards/{boardId}/tasks/{taskId}
  return collection(db, "boards", board, "tasks");
}

function buildQuery(colRef) {
  // We keep a base orderBy createdAt for snapshot stability.
  // Then we sort client-side based on user's sort preference.
  return query(colRef, orderBy("createdAt", "desc"));
}

function applyClientFiltersAndSort(tasks) {
  const statusFilter = statusFilterEl.value;
  const sortBy = sortByEl.value;

  let filtered = tasks;
  if (statusFilter !== "all") {
    filtered = filtered.filter(t => (t.status || "open") === statusFilter);
  }

  // Sort client-side for flexible behavior
  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === "dueDate") {
      const ad = a.dueDate || "9999-12-31";
      const bd = b.dueDate || "9999-12-31";
      return ad.localeCompare(bd);
    }
    if (sortBy === "priority") {
      const ap = priorityRank(a.priority || "med");
      const bp = priorityRank(b.priority || "med");
      // high first, then newest
      if (bp !== ap) return bp - ap;
      return (b.createdAtMs || 0) - (a.createdAtMs || 0);
    }
    // createdAt newest first (already, but keep stable)
    return (b.createdAtMs || 0) - (a.createdAtMs || 0);
  });

  return sorted;
}

function attachTaskActions() {
  taskListEl.addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;

    if (!currentBoard) return setNote("Join a board first.");

    const act = btn.dataset.act;
    const id = btn.dataset.id;
    const ref = doc(db, "boards", currentBoard, "tasks", id);

    try {
      if (act === "delete") {
        await deleteDoc(ref);
        setNote("Task deleted.");
        return;
      }

      if (act === "open" || act === "doing" || act === "done") {
        await updateDoc(ref, {
          status: act,
          updatedAt: serverTimestamp()
        });
        setNote(`Marked as ${prettyStatus(act)}.`);
      }
    } catch (err) {
      console.error(err);
      setNote("Action failed. Check Firebase config & rules.");
    }
  }, { passive: true });
}

async function joinBoard() {
  const board = sanitizeBoardId(boardIdEl.value);
  if (!board) {
    renderEmpty("Type a Board Code, then Join.");
    setFooter("Not connected");
    return;
  }

  boardIdEl.value = board;
  savePrefs();

  // Unsubscribe from previous board
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }

  currentBoard = board;
  renderEmpty("Connecting…");

  try {
    const colRef = getTasksCollection(currentBoard);
    const q = buildQuery(colRef);

    unsubscribe = onSnapshot(q, (snap) => {
      const tasks = snap.docs.map(d => {
        const data = d.data();
        const createdAtMs = data.createdAt?.toMillis?.() ?? 0;
        return { id: d.id, ...data, createdAtMs };
      });

      const finalTasks = applyClientFiltersAndSort(tasks);

      if (!finalTasks.length) {
        renderEmpty("No tasks yet. Add one above 👆");
        setFooter(`Connected to "${currentBoard}" • 0 tasks`);
        return;
      }

      taskListEl.innerHTML = finalTasks.map(cardHTML).join("");
      setFooter(`Connected to "${currentBoard}" • ${finalTasks.length} showing`);
    }, (err) => {
      console.error(err);
      renderEmpty("Couldn’t connect. Check Firebase config & rules.");
      setFooter("Connection error");
    });

    setNote(`Joined board "${currentBoard}".`);
  } catch (err) {
    console.error(err);
    renderEmpty("Couldn’t connect. Check Firebase config & rules.");
    setFooter("Connection error");
  }
}

taskForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentBoard) return setNote("Join a board first.");

  const title = taskTitleEl.value.trim();
  if (!title) return;

  const createdBy = (displayNameEl.value || "").trim() || "Someone";
  const assignee = (assigneeEl.value || "").trim();
  const dueDate = dueDateEl.value || "";
  const priority = priorityEl.value;

  savePrefs();

  try {
    await addDoc(getTasksCollection(currentBoard), {
      title,
      assignee,
      dueDate,
      priority,
      status: "open",
      createdBy,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    });

    taskTitleEl.value = "";
    setNote("Task added ✅");
  } catch (err) {
    console.error(err);
    setNote("Couldn’t add task. Check Firebase config & rules.");
  }
});

joinBtn.addEventListener("click", joinBoard);

boardIdEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") joinBoard();
});

displayNameEl.addEventListener("blur", savePrefs);
statusFilterEl.addEventListener("change", () => { savePrefs(); if (currentBoard) joinBoard(); });
sortByEl.addEventListener("change", () => { savePrefs(); if (currentBoard) joinBoard(); });

clearDoneBtn.addEventListener("click", async () => {
  if (!currentBoard) return setNote("Join a board first.");

  try {
    const colRef = getTasksCollection(currentBoard);
    const qDone = query(colRef, where("status", "==", "done"));
    const snap = await getDocs(qDone);

    if (snap.empty) return setNote("No done tasks to clear.");

    const batch = writeBatch(db);
    snap.forEach(d => batch.delete(d.ref));
    await batch.commit();

    setNote(`Cleared ${snap.size} done task(s). 🧹`);
  } catch (err) {
    console.error(err);
    setNote("Couldn’t clear done tasks. Check Firebase rules.");
  }
});

// Init
attachTaskActions();
loadPrefs();
if (boardIdEl.value.trim()) {
  joinBoard();
} else {
  renderEmpty("Type a Board Code, then Join 🧩");
}
setFooter("Not connected");
